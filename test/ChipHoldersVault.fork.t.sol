// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChipHoldersVault} from "../src/ChipHoldersVault.sol";
import {INPM} from "../src/ChipFeeVault.sol";
import {IChipFactoryLite} from "../src/ChipCreatorVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface INPMFull {
    struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }
    function mint(MintParams calldata p) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function ownerOf(uint256) external view returns (address);
}
interface IRouter02 {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}
interface IV3F { function getPool(address, address, uint24) external view returns (address); }
interface IV3Pool { function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool); }

/// Sul fork: una posizione vera di un chip token vero nel vault holders, uno
/// swap vero che genera fee, collect che le divide 80/20, poi epoca e claim.
contract ChipHoldersVaultForkTest is Test {
    address constant FACTORY = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;
    address constant RH4 = 0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant V3F = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    ChipHoldersVault vault;
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address token; address pool; bool tokenIs0;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        vault = new ChipHoldersVault(INPM(NPM), IChipFactoryLite(FACTORY), RH4, WETH, ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, keeper);
        // un chip con un mercato WETH gia' aperto: GREEN #22 e' il primo che si trova con un pool
        for (uint256 id = 22; id > 1 && pool == address(0); --id) {
            address t = IChipFactoryLite(FACTORY).chip(id).token;
            if (t == address(0)) continue;
            (address a, address b) = t < WETH ? (t, WETH) : (WETH, t);
            address p = IV3F(V3F).getPool(a, b, 10000);
            if (p != address(0)) { token = t; pool = p; }
        }
        require(pool != address(0), "no chip pool found");
        tokenIs0 = token < WETH;
    }

    function test_real_position_fees_split_then_epoch_pays_holders() public {
        // alice mette una posizione a range pieno nel vault: 50M token + 0.2 WETH
        deal(token, alice, 50_000_000e18);
        vm.deal(alice, 2 ether);
        vm.startPrank(alice);
        (bool ok, ) = WETH.call{value: 0.2 ether}(""); require(ok);
        IERC20(token).approve(NPM, type(uint256).max);
        IERC20(WETH).approve(NPM, type(uint256).max);
        (uint256 tokenId, , , ) = INPMFull(NPM).mint(INPMFull.MintParams({
            token0: tokenIs0 ? token : WETH, token1: tokenIs0 ? WETH : token, fee: 10000, tickLower: -887200, tickUpper: 887200,
            amount0Desired: tokenIs0 ? 50_000_000e18 : 0.2 ether, amount1Desired: tokenIs0 ? 0.2 ether : 50_000_000e18,
            amount0Min: 0, amount1Min: 0, recipient: address(vault), deadline: block.timestamp
        }));
        vm.stopPrank();
        assertEq(INPMFull(NPM).ownerOf(tokenId), address(vault));

        // bob compra: 0.1 WETH di fee dell'1% -> 0.001 WETH sul pool, una fetta alla nostra posizione
        vm.deal(bob, 1 ether);
        vm.startPrank(bob);
        (ok, ) = WETH.call{value: 0.1 ether}(""); require(ok);
        IERC20(WETH).approve(ROUTER02, 0.1 ether);
        uint256 got = IRouter02(ROUTER02).exactInputSingle(IRouter02.ExactInputSingleParams({
            tokenIn: WETH, tokenOut: token, fee: 10000, recipient: bob, amountIn: 0.1 ether, amountOutMinimum: 1, sqrtPriceLimitX96: 0
        }));
        // e rivende meta': fee anche sul lato token
        IERC20(token).approve(ROUTER02, got / 2);
        IRouter02(ROUTER02).exactInputSingle(IRouter02.ExactInputSingleParams({
            tokenIn: token, tokenOut: WETH, fee: 10000, recipient: bob, amountIn: got / 2, amountOutMinimum: 1, sqrtPriceLimitX96: 0
        }));
        vm.stopPrank();

        uint256 factoryBefore = IERC20(token).balanceOf(FACTORY);
        (uint256 a0, uint256 a1) = vault.collect(tokenId);
        uint256 feeTok = tokenIs0 ? a0 : a1; uint256 feeWeth = tokenIs0 ? a1 : a0;
        assertGt(feeWeth, 0); assertGt(feeTok, 0);
        assertEq(vault.undistributed(token, WETH), feeWeth * 8000 / 10000, "holders weth");
        assertEq(vault.undistributed(token, token), feeTok * 8000 / 10000, "holders token");
        assertEq(IERC20(token).balanceOf(FACTORY) - factoryBefore, feeTok - feeTok * 8000 / 10000, "factory reserve");
        assertEq(address(vault).balance, feeWeth - feeWeth * 8000 / 10000, "buyback eth");

        // l'epoca con la fixture (id 3): tre epoche minime prima, poi quella vera
        string memory json = vm.readFile("test/fixtures/merkle.json");
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        address[] memory assets = new address[](2); assets[0] = WETH; assets[1] = token;
        uint256[] memory amounts = new uint256[](2);
        address[] memory a1s = new address[](1); a1s[0] = token;
        uint256[] memory m1 = new uint256[](1); m1[0] = 1;
        vm.startPrank(keeper);
        for (uint256 i; i < 3; ++i) vault.publish(token, bytes32(uint256(1)), 1, a1s, m1, 7 days);
        amounts[0] = vault.undistributed(token, WETH); amounts[1] = vault.undistributed(token, token);
        uint256 id = vault.publish(token, root, 1000e18, assets, amounts, 30 days);
        vm.stopPrank();
        assertEq(id, 3);
        // il keeper spinge il pagamento a 0x1111… (600 su 1000)
        address holder = 0x1111111111111111111111111111111111111111;   // sul fork puo' avere gia' qualcosa: si guardano i delta
        uint256 w0 = IERC20(WETH).balanceOf(holder); uint256 t0 = IERC20(token).balanceOf(holder);
        bytes32[] memory proof = vm.parseJsonBytes32Array(json, ".leaves[0].proof");
        vm.prank(keeper);
        vault.claim(3, holder, 600e18, proof);
        assertEq(IERC20(WETH).balanceOf(holder) - w0, amounts[0] * 600e18 / 1000e18, "holder weth");
        assertEq(IERC20(token).balanceOf(holder) - t0, amounts[1] * 600e18 / 1000e18, "holder token");
    }
}
