// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {RH4Curve} from "../../src/curve/RH4Curve.sol";
import {CurveFeeVault} from "../../src/curve/CurveFeeVault.sol";
import {INPM} from "../../src/ChipFeeVault.sol";
import {ISwapRouter02, IPoolManager} from "../../src/ChipBuybackVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV3Factory { function createPool(address, address, uint24) external returns (address); function getPool(address, address, uint24) external view returns (address); }
interface IV3Pool {
    function initialize(uint160) external;
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}
interface IRouter02 {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

/// swaps in an empty pool: records what the pool asked us to pay
contract FreeSwapper {
    int256 public paid0; int256 public paid1;
    function go(address pool, bool zeroForOne, uint160 limit) external {
        IV3Pool(pool).swap(address(this), zeroForOne, int256(1e30), limit, "");
    }
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        paid0 = a0; paid1 = a1;
        require(a0 <= 0 && a1 <= 0, "pool wants payment");
    }
}

/// splits one big buy in many small ones inside the snipe window
contract Splitter {
    RH4Curve c;
    constructor(RH4Curve c_) { c = c_; }
    receive() external payable {}
    function spam(address token, uint256 n, uint256 each) external payable {
        for (uint256 i; i < n; ++i) { if (c.graduated(token)) break; c.buy{value: each}(token, 0, 0); }
    }
}

contract AuditForkTest is Test {
    address constant FACTORY = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;
    address constant RH4 = 0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant V3F = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    RH4Curve curve; CurveFeeVault vault;
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    uint256 constant THRESHOLD = 0.05 ether;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        curve = new RH4Curve(WETH, V3F, NPM, address(this));
        vault = new CurveFeeVault(INPM(NPM), FACTORY, RH4, WETH, ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, address(curve), keeper);
        curve.setFeeVault(address(vault));
        curve.setQuote(WETH, true, 0.01 ether);
        vm.deal(alice, 10 ether); vm.deal(bob, 10 ether);
    }

    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 ratioX96 = (amount1 << 96) / amount0;
        return uint160(_sqrt(ratioX96) << 48);
    }
    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0; uint256 z = (x + 1) / 2; y = x; while (z < y) { y = z; z = (x / z + z) / 2; }
    }
    /// sqrtP for token price = k * expected graduation price (k as 1e18 fixed)
    function _attackerSqrtP(address token, uint256 k1e18) internal view returns (uint160) {
        uint256 qExp = THRESHOLD * 30 / 85 * 800 / 273;
        uint256 quoteSide = qExp * k1e18 / 1e18;
        bool tokenIs0 = token < WETH;
        return _sqrtPriceX96(tokenIs0 ? curve.LP_SUPPLY() : quoteSide, tokenIs0 ? quoteSide : curve.LP_SUPPLY());
    }

    // 1. the precomputed pool address matches the real factory (init code hash sanity)
    function test_pool_address_matches_factory() public {
        vm.prank(creator);
        address token = curve.launch("A", "A", WETH, THRESHOLD, 5000);
        address[4] memory pools = curve.poolsOf(token);
        address real = IV3Factory(V3F).createPool(token, WETH, 10000);
        assertEq(pools[3], real, "init code hash / factory mismatch");
        address real100 = IV3Factory(V3F).createPool(token, WETH, 100);
        assertEq(pools[0], real100);
    }

    // 2. anyone can initialise the graduation pool at any price before graduation, with no tokens
    //    high token price -> the full-range mint deposits ALL the quote and only T/k tokens.
    //    attacker then sells a handful of curve tokens into the pool and takes the whole raise.
    function test_empty_pool_price_moves_for_free() public {
        vm.prank(creator);
        address token = curve.launch("A", "A", WETH, THRESHOLD, 5000);
        address pool = curve.poolsOf(token)[3];
        IV3Factory(V3F).createPool(token, WETH, 10000);
        IV3Pool(pool).initialize(_attackerSqrtP(token, 1e18));
        FreeSwapper s = new FreeSwapper();
        uint160 target = _attackerSqrtP(token, 1e18 * 1000);
        (uint160 before, , , , , , ) = IV3Pool(pool).slot0();
        s.go(pool, target < before, target);
        (uint160 after_, , , , , , ) = IV3Pool(pool).slot0();
        assertEq(after_, target);
        assertEq(s.paid0(), 0); assertEq(s.paid1(), 0);
    }

    // 5. the anti-snipe cap is per call: one tx buys the whole curve in block 1
    function test_fix_recentres_price() public {
        vm.prank(creator);
        address token = curve.launch("A", "A", WETH, THRESHOLD, 5000);
        vm.roll(block.number + 101);
        address pool = curve.poolsOf(token)[3];
        vm.startPrank(bob);
        IV3Factory(V3F).createPool(token, WETH, 10000);
        IV3Pool(pool).initialize(_attackerSqrtP(token, 10_000e18));
        uint256 bobTokens = curve.buy{value: 0.001 ether}(token, 0, 0);
        vm.stopPrank();
        vm.prank(alice);
        curve.buy{value: 0.5 ether}(token, 0, 0);
        (, , , , , , , , uint256 raised, , , ) = curve.launches(token);
        (uint160 sqrtP, , , , , , ) = IV3Pool(pool).slot0();
        uint256 priceX96 = (uint256(sqrtP) * uint256(sqrtP)) >> 96;
        if (token < WETH) assertApproxEqRel((priceX96 * curve.LP_SUPPLY()) >> 96, raised, 0.001e18);
        else assertApproxEqRel((priceX96 * raised) >> 96, curve.LP_SUPPLY(), 0.001e18);
        assertApproxEqRel(IERC20(WETH).balanceOf(pool), raised, 0.001e18);
        assertApproxEqRel(IERC20(token).balanceOf(pool), curve.LP_SUPPLY(), 0.001e18);
        vm.startPrank(bob);
        IERC20(token).approve(ROUTER02, bobTokens);
        uint256 wethOut = IRouter02(ROUTER02).exactInputSingle(IRouter02.ExactInputSingleParams({
            tokenIn: token, tokenOut: WETH, fee: 10000, recipient: bob, amountIn: bobTokens, amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }));
        vm.stopPrank();
        console2.log("bob WETH out with fix (wei)", wethOut, "of raised", raised);
        assertLt(wethOut, raised / 4);
    }
}

contract FixCheckLow is AuditForkTest {
    function test_fix_low_side_numbers() public {
        vm.prank(creator);
        address token = curve.launch("A", "A", WETH, THRESHOLD, 5000);
        vm.roll(block.number + 101);
        address pool = curve.poolsOf(token)[3];
        vm.startPrank(bob);
        IV3Factory(V3F).createPool(token, WETH, 10000);
        IV3Pool(pool).initialize(_attackerSqrtP(token, 1e18 / 10_000));
        vm.stopPrank();
        vm.prank(alice);
        curve.buy{value: 0.5 ether}(token, 0, 0);
        (, , , , , , , , uint256 raised, , , ) = curve.launches(token);
        (uint160 sqrtP, int24 tick, , , , , ) = IV3Pool(pool).slot0();
        console2.log("token is token0", token < WETH);
        console2.log("raised", raised, "pool WETH", IERC20(WETH).balanceOf(pool));
        console2.log("pool tokens", IERC20(token).balanceOf(pool) / 1e18, "dead", IERC20(token).balanceOf(0x000000000000000000000000000000000000dEaD) / 1e18);
        console2.log("curve WETH left", IERC20(WETH).balanceOf(address(curve)), "curve tok", IERC20(token).balanceOf(address(curve)));
        console2.log("sqrtP", sqrtP, "target", _attackerSqrtP(token, 1e18));
        console2.logInt(tick);
    }
}
