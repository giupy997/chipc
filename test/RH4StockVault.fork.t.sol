// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RH4StockVault} from "../src/RH4StockVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV3PoolSlot0 { function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool); }

/// Router, pool, PoolManager e hook VERI su un fork della chain: qui si
/// prova che gli ETH diventano davvero NVDA e SNDK, e che il buyback
/// consegna RH4 alla fabbrica.
contract RH4StockVaultForkTest is Test {
    address constant FACTORY = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;
    address constant RH4 = 0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SNDK = 0xB90A19fF0Af67f7779afF50A882A9CfF42446400;
    address constant NVDA_WETH_500 = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C;
    address constant SNDK_WETH_3000 = 0x995c1Ad5Eb998b1BdD89F515C4BB64760c411b62;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address marketing = makeAddr("marketing");
    RH4StockVault vault;

    function setUp() public {
        string memory rpc = vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com"));
        vm.createSelectFork(rpc);
        vault = new RH4StockVault(
            owner, keeper, marketing, RH4, WETH, FACTORY,
            ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, 6000, 2000, 2000
        );
        vm.startPrank(owner);
        vault.setStock(NVDA, true, 500);
        vault.setStock(SNDK, true, 3000);
        vm.stopPrank();
        vm.deal(address(this), 1 ether);
        (bool ok, ) = address(vault).call{value: 1 ether}("");
        require(ok);
        vm.prank(keeper);
        vault.allocate();
    }

    /// azioni per 1 WETH dallo spot del pool, meno il 5%: il "minOut da fuori"
    function _minOut(address pool, address stock, uint256 ethIn) internal view returns (uint256) {
        (uint160 sqrtP, , , , , , ) = IV3PoolSlot0(pool).slot0();
        uint256 p = uint256(sqrtP);
        bool wethIs0 = WETH < stock;
        // prezzo = token1/token0 = (sqrtP/2^96)^2
        uint256 out = wethIs0
            ? ((ethIn * p) >> 96) * p >> 96
            : ((ethIn << 96) / p << 96) / p;
        return out * 95 / 100;
    }

    function test_convert_eth_to_nvda_and_sndk() public {
        uint256 minN = _minOut(NVDA_WETH_500, NVDA, 0.3 ether);
        uint256 minS = _minOut(SNDK_WETH_3000, SNDK, 0.3 ether);
        vm.startPrank(keeper);
        vault.convert(NVDA, 0.3 ether, minN);
        vault.convert(SNDK, 0.3 ether, minS);
        vm.stopPrank();
        assertGe(IERC20(NVDA).balanceOf(address(vault)), minN);
        assertGe(IERC20(SNDK).balanceOf(address(vault)), minS);
        assertEq(vault.undistributed(NVDA), IERC20(NVDA).balanceOf(address(vault)));
        assertEq(vault.undistributed(SNDK), IERC20(SNDK).balanceOf(address(vault)));
        assertEq(vault.ethForStocks(), 0);
        assertEq(address(vault).balance, 0.2 ether);   // resta solo il secchio buyback
    }

    function test_convert_minOut_guards() public {
        uint256 minN = _minOut(NVDA_WETH_500, NVDA, 0.3 ether);
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        vault.convert(NVDA, 0.3 ether, minN * 2);
    }

    function test_buyback_lands_rh4_in_factory() public {
        uint256 before = IERC20(RH4).balanceOf(FACTORY);
        vm.prank(keeper);
        vault.buyback(0.2 ether, 1);
        assertGt(IERC20(RH4).balanceOf(FACTORY), before);
        assertEq(vault.ethForBuyback(), 0);
        assertEq(IERC20(RH4).balanceOf(address(vault)), 0);   // nulla resta nel vault
    }

    function test_buyback_cannot_touch_holder_eth() public {
        vm.prank(keeper);
        vm.expectRevert(RH4StockVault.TooMuch.selector);
        vault.buyback(0.5 ether, 1);   // il secchio buyback ha solo 0.2
    }
}
