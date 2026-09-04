// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChipBuybackVault, IV3Pool, ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";
import {INPM} from "../src/ChipFeeVault.sol";
import {IChipFactoryLite} from "../src/ChipCreatorVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Un NPM finto che consegna le fee: la fabbrica, i pool, il router, il
/// PoolManager e l'hook di pons sono quelli VERI, su un fork della chain.
contract MockNPMFork {
    address public t0; address public t1; uint256 public f0; uint256 public f1;
    function set(address a, address b, uint256 x, uint256 y) external { t0 = a; t1 = b; f0 = x; f1 = y; }
    function positions(uint256) external view returns (
        uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128
    ) { return (0, address(0), t0, t1, 10000, 0, 0, 0, 0, 0, 0, 0); }
    function collect(INPM.CollectParams calldata p) external returns (uint256 a0, uint256 a1) {
        a0 = f0; a1 = f1; f0 = 0; f1 = 0;
        if (a0 > 0) IERC20(t0).transfer(p.recipient, a0);
        if (a1 > 0) IERC20(t1).transfer(p.recipient, a1);
    }
}

contract ChipBuybackVaultForkTest is Test {
    address constant FACTORY = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;
    address constant RH4 = 0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_WETH_500 = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant TCHIP = 0x76B185eC36215D197265D56927e570f38eD0c3A8;
    address constant TCHIP_MINTER = 0xAE1Ef0187fb073AA2Ad9d81176EBB23E6c21b8e8;

    ChipBuybackVault vault;
    MockNPMFork npm;

    function setUp() public {
        string memory rpc = vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com"));
        vm.createSelectFork(rpc);
        npm = new MockNPMFork();
        vault = new ChipBuybackVault(
            INPM(address(npm)), IChipFactoryLite(FACTORY), RH4, WETH, NVDA,
            IV3Pool(NVDA_WETH_500), ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, 5000
        );
    }

    /// ETH nel vault -> RH4 nella fabbrica, sul pool v4 vero con l'hook di pons.
    function test_buybackCompraRh4PerLaFabbrica() public {
        vm.deal(address(vault), 0.01 ether);
        uint256 before = IERC20(RH4).balanceOf(FACTORY);
        vault.buyback(0.01 ether);
        uint256 got = IERC20(RH4).balanceOf(FACTORY) - before;
        assertGt(got, 0, "la fabbrica ha ricevuto RH4");
        assertEq(address(vault).balance, 0, "l'ETH e' stato speso tutto");
        emit log_named_decimal_uint("RH4 comprati con 0.01 ETH", got, 18);
    }

    /// Il flusso intero da collect(): fee in TCHIP e NVDA -> meta' al coniatore,
    /// TCHIP in riserva, NVDA -> WETH -> ETH -> RH4 in fabbrica. Una transazione.
    function test_collectFaTuttoInUnaTransazione() public {
        // fee finte: 1000 TCHIP + 0.05 NVDA, consegnate dal mock NPM
        deal(TCHIP, address(npm), 1000e18);
        deal(NVDA, address(npm), 0.05e18);
        npm.set(TCHIP, NVDA, 1000e18, 0.05e18);

        uint256 minterTchip = IERC20(TCHIP).balanceOf(TCHIP_MINTER);
        uint256 minterNvda = IERC20(NVDA).balanceOf(TCHIP_MINTER);
        uint256 factoryTchip = IERC20(TCHIP).balanceOf(FACTORY);
        uint256 factoryRh4 = IERC20(RH4).balanceOf(FACTORY);

        vault.collect(1);

        assertEq(IERC20(TCHIP).balanceOf(TCHIP_MINTER) - minterTchip, 500e18, "meta' TCHIP al coniatore");
        assertEq(IERC20(NVDA).balanceOf(TCHIP_MINTER) - minterNvda, 0.025e18, "meta' NVDA al coniatore");
        assertEq(IERC20(TCHIP).balanceOf(FACTORY) - factoryTchip, 500e18, "meta' TCHIP in riserva");
        uint256 rh4 = IERC20(RH4).balanceOf(FACTORY) - factoryRh4;
        assertGt(rh4, 0, "la NVDA e' diventata RH4 nella fabbrica");
        assertEq(address(vault).balance, 0, "niente ETH rimasto");
        assertEq(IERC20(NVDA).balanceOf(address(vault)), 0);
        assertEq(IERC20(WETH).balanceOf(address(vault)), 0);
        emit log_named_decimal_uint("RH4 dalla meta' di 0.05 NVDA", rh4, 18);
    }

    /// Fee in WETH: stessa strada, senza la gamba NVDA.
    function test_collectConWeth() public {
        deal(TCHIP, address(npm), 10e18);
        deal(WETH, address(npm), 0.002e18);
        npm.set(TCHIP, WETH, 10e18, 0.002e18);
        uint256 factoryRh4 = IERC20(RH4).balanceOf(FACTORY);
        vault.collect(1);
        assertGt(IERC20(RH4).balanceOf(FACTORY) - factoryRh4, 0, "WETH -> RH4 in fabbrica");
        assertEq(address(vault).balance, 0);
    }

    /// 100% riserva: nessuna quota al coniatore, tutto in riserva e in buyback.
    function test_varianteCentoPerCentoRiserva() public {
        ChipBuybackVault v0 = new ChipBuybackVault(
            INPM(address(npm)), IChipFactoryLite(FACTORY), RH4, WETH, NVDA,
            IV3Pool(NVDA_WETH_500), ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, 0
        );
        deal(TCHIP, address(npm), 100e18);
        deal(WETH, address(npm), 0.001e18);
        npm.set(TCHIP, WETH, 100e18, 0.001e18);
        uint256 m = IERC20(TCHIP).balanceOf(TCHIP_MINTER);
        uint256 f = IERC20(TCHIP).balanceOf(FACTORY);
        v0.collect(1);
        assertEq(IERC20(TCHIP).balanceOf(TCHIP_MINTER), m, "il coniatore non prende nulla");
        assertEq(IERC20(TCHIP).balanceOf(FACTORY) - f, 100e18, "tutto il TCHIP in riserva");
    }

    /// Un ordine troppo grande per lo spot non blocca le fee: l'ETH resta e si
    /// ritenta a fette.
    function test_buybackTroppoGrandeRestaInAttesa() public {
        vm.deal(address(vault), 50 ether); // vs ~11 ETH nel pool: impatto enorme
        vm.expectRevert();
        vault.buyback(50 ether);
        assertEq(address(vault).balance, 50 ether, "l'ETH non si e' mosso");
        // a fette piccole passa
        uint256 before = IERC20(RH4).balanceOf(FACTORY);
        vault.buyback(0.05 ether);
        assertGt(IERC20(RH4).balanceOf(FACTORY), before);
    }

    function test_nessunoPuoChiamareIlCallback() public {
        vm.expectRevert(ChipBuybackVault.NotPoolManager.selector);
        vault.unlockCallback(abi.encode(uint256(1), uint256(0)));
    }
}
