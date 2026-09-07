// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RH4Curve} from "../../src/curve/RH4Curve.sol";
import {CurveFeeVault} from "../../src/curve/CurveFeeVault.sol";
import {INPM} from "../../src/ChipFeeVault.sol";
import {ISwapRouter02, IPoolManager} from "../../src/ChipBuybackVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV3Pool { function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool); function liquidity() external view returns (uint128); }
interface INPMOwner { function ownerOf(uint256) external view returns (address); }
interface IRouter02 {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

/// Sul fork: graduazione dentro il VERO position manager, pool vero, e poi
/// uno swap vero attraverso il router. E' il percorso che conta.
contract RH4CurveForkTest is Test {
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
    address keeper = makeAddr("keeper");

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        curve = new RH4Curve(WETH, V3F, NPM, address(this));
        vault = new CurveFeeVault(INPM(NPM), FACTORY, RH4, WETH, ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, address(curve), keeper);
        curve.setFeeVault(address(vault));
        curve.setQuote(WETH, true, 0.01 ether);
        vm.deal(alice, 10 ether);
    }

    function test_graduate_into_real_pool_and_trade() public {
        vm.prank(creator);
        address token = curve.launch("Fork Meme", "FMEME", WETH, 0.05 ether, 5000);
        vm.roll(block.number + 101);
        vm.prank(alice);
        uint256 got = curve.buy{value: 0.5 ether}(token, 0, 0);
        assertEq(got, curve.CURVE_SUPPLY());
        assertTrue(curve.graduated(token));
        (, , , , , , , , uint256 raised, , uint256 lpId, address pool) = curve.launches(token);
        // il pool esiste, ha liquidita', e la posizione appartiene al vault
        assertGt(IV3Pool(pool).liquidity(), 0);
        assertEq(INPMOwner(NPM).ownerOf(lpId), address(vault));
        // la raccolta e' finita nel pool (meno gli spiccioli), niente resta nella curva
        assertLt(IERC20(WETH).balanceOf(address(curve)), raised / 100);
        assertEq(IERC20(token).balanceOf(address(curve)), 0);
        // prezzo del pool ~ raccolta / 200M
        (uint160 sqrtP, , , , , , ) = IV3Pool(pool).slot0();
        _checkPoolPrice(sqrtP, token < WETH, raised, curve.LP_SUPPLY());
        // e si scambia davvero: alice compra altro token dal pool con ETH via router
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        (bool ok, ) = WETH.call{value: 0.01 ether}("");
        require(ok);
        IERC20(WETH).approve(ROUTER02, 0.01 ether);
        uint256 before = IERC20(token).balanceOf(alice);
        uint256 out = IRouter02(ROUTER02).exactInputSingle(IRouter02.ExactInputSingleParams({
            tokenIn: WETH, tokenOut: token, fee: 10000, recipient: alice, amountIn: 0.01 ether, amountOutMinimum: 1, sqrtPriceLimitX96: 0
        }));
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(IERC20(token).balanceOf(alice) - before, out);
        // le fee di quello swap si riscuotono dal vault, meta' al creator
        vault.collect(lpId);
        assertGt(vault.claimable(creator, WETH), 0);
    }

    /// prezzo del pool letto dallo sqrtPrice: deve valere raccolta / 200M, in entrambi gli ordini dei token
    function _checkPoolPrice(uint160 sqrtP, bool tokenIs0, uint256 raised, uint256 lp) internal pure {
        uint256 priceX96 = (uint256(sqrtP) * uint256(sqrtP)) >> 96;         // token1 per token0, X96
        if (tokenIs0) assertApproxEqRel((priceX96 * lp) >> 96, raised, 0.001e18);   // weth/token * 200M = raccolta
        else assertApproxEqRel((priceX96 * raised) >> 96, lp, 0.001e18);            // token/weth * raccolta = 200M
    }
}
