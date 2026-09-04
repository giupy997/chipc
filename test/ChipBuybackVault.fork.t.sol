// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChipBuybackVault, IV3Factory, ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";
import {ChipToken} from "../src/ChipToken.sol";
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
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
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
            INPM(address(npm)), IChipFactoryLite(FACTORY), RH4, WETH,
            IV3Factory(V3_FACTORY), ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, 5000
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

        // la meta' del coniatore matura nel vault: si ritira con claim
        assertEq(IERC20(TCHIP).balanceOf(TCHIP_MINTER), minterTchip, "niente parte da solo");
        assertEq(vault.claimable(TCHIP_MINTER, TCHIP), 500e18, "meta' TCHIP maturata");
        assertEq(vault.claimable(TCHIP_MINTER, NVDA), 0.025e18, "meta' NVDA maturata");
        assertEq(IERC20(TCHIP).balanceOf(FACTORY) - factoryTchip, 500e18, "meta' TCHIP in riserva");
        uint256 rh4 = IERC20(RH4).balanceOf(FACTORY) - factoryRh4;
        assertGt(rh4, 0, "la NVDA e' diventata RH4 nella fabbrica");
        assertEq(address(vault).balance, 0, "niente ETH rimasto");
        assertEq(IERC20(NVDA).balanceOf(address(vault)), 0.025e18, "nel vault resta solo la NVDA del coniatore");
        assertEq(IERC20(WETH).balanceOf(address(vault)), 0);

        // il claim: solo lui, e una volta sola
        vm.prank(address(0xBEEF));
        vm.expectRevert(ChipBuybackVault.NothingToBuy.selector);
        vault.claim(TCHIP);
        address[] memory toks = new address[](2); toks[0] = TCHIP; toks[1] = NVDA;
        vm.prank(TCHIP_MINTER);
        vault.claimMany(toks);
        assertEq(IERC20(TCHIP).balanceOf(TCHIP_MINTER) - minterTchip, 500e18, "TCHIP ritirati");
        assertEq(IERC20(NVDA).balanceOf(TCHIP_MINTER) - minterNvda, 0.025e18, "NVDA ritirata");
        assertEq(vault.claimable(TCHIP_MINTER, TCHIP), 0);
        assertEq(vault.held(NVDA), 0, "il vault non trattiene piu' nulla");
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
            INPM(address(npm)), IChipFactoryLite(FACTORY), RH4, WETH,
            IV3Factory(V3_FACTORY), ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, 0
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

    /// Una quote senza pool con WETH (un'azione tokenizzata di domani, prima
    /// che qualcuno le apra il mercato): resta nel vault, non viene sepolta.
    function test_quoteSenzaPoolRestaInAttesa() public {
        ChipToken alien = new ChipToken("Alien", "ALN", 999, 1_000_000e18, address(npm), 0, address(this));
        deal(TCHIP, address(npm), 10e18);
        npm.set(TCHIP, address(alien), 10e18, 100e18);
        uint256 fBefore = alien.balanceOf(FACTORY);
        vault.collect(1);
        assertEq(alien.balanceOf(FACTORY), fBefore, "niente sepolto in fabbrica");
        assertEq(vault.claimable(TCHIP_MINTER, address(alien)), 50e18, "la meta' del coniatore matura");
        assertEq(alien.balanceOf(address(vault)), 100e18, "tutto nel vault: 50 in attesa di claim, 50 in attesa di pool");
        vm.expectRevert(ChipBuybackVault.NoRoute.selector);
        vault.convert(address(alien));
    }

    /// Due sweep di fila: il secondo non tocca cio' che il primo ha messo da
    /// parte per il coniatore.
    function test_dueSweepNonSiRubanoIlClaim() public {
        deal(TCHIP, address(npm), 100e18); deal(WETH, address(npm), 0.002e18);
        npm.set(TCHIP, WETH, 100e18, 0.002e18);
        vault.collect(1);
        assertEq(vault.claimable(TCHIP_MINTER, WETH), 0.001e18);
        deal(TCHIP, address(npm), 100e18); deal(WETH, address(npm), 0.002e18);
        npm.set(TCHIP, WETH, 100e18, 0.002e18);
        vault.collect(1);
        assertEq(vault.claimable(TCHIP_MINTER, WETH), 0.002e18, "il claim WETH si somma");
        assertEq(IERC20(WETH).balanceOf(address(vault)), 0.002e18, "il buyback ha usato solo la parte libera");
        assertEq(vault.claimable(TCHIP_MINTER, TCHIP), 100e18);
    }

    function test_nessunoPuoChiamareIlCallback() public {
        vm.expectRevert(ChipBuybackVault.NotPoolManager.selector);
        vault.unlockCallback(abi.encode(uint256(1), uint256(0)));
    }
}
