// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChipBuybackVault, ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";
import {INPM} from "../src/ChipFeeVault.sol";
import {IChipFactoryLite} from "../src/ChipCreatorVault.sol";
import {ChipToken} from "../src/ChipToken.sol";
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

interface IV3PoolSlot0 { function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool); }
interface IOwnerProbe { function owner() external view returns (address); }

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

    address keeper = makeAddr("keeper");
    address passer = makeAddr("passer");
    ChipBuybackVault vault;
    MockNPMFork npm;

    function setUp() public {
        string memory rpc = vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com"));
        vm.createSelectFork(rpc);
        npm = new MockNPMFork();
        vault = _vault(5000);
    }

    function _vault(uint256 bps) internal returns (ChipBuybackVault) {
        return new ChipBuybackVault(
            INPM(address(npm)), IChipFactoryLite(FACTORY), RH4, WETH,
            ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, keeper, bps
        );
    }

    /// minimo "da fuori": lo spot del pool NVDA/WETH meno il 5% (token0 = WETH)
    function _nvdaMinOut(uint256 amount) internal view returns (uint256) {
        (uint160 sqrtP, , , , , , ) = IV3PoolSlot0(NVDA_WETH_500).slot0();
        uint256 wethOut = ((amount << 96) / sqrtP << 96) / sqrtP;
        return wethOut * 95 / 100;
    }

    /// Il flusso intero: collect (di tutti) accredita e parcheggia; l'executor
    /// converte e ricompra. Meta' TCHIP al coniatore, meta' in riserva; la NVDA
    /// del coniatore in claim, il resto -> ETH -> RH4 in fabbrica.
    function test_collectPoiConvertPoiBuyback() public {
        deal(TCHIP, address(npm), 1000e18);
        deal(NVDA, address(npm), 0.05e18);
        npm.set(TCHIP, NVDA, 1000e18, 0.05e18);
        uint256 factoryTchip = IERC20(TCHIP).balanceOf(FACTORY);
        uint256 factoryRh4 = IERC20(RH4).balanceOf(FACTORY);

        vm.prank(passer);
        vault.collect(1);

        assertEq(vault.claimable(TCHIP_MINTER, TCHIP), 500e18, "meta' TCHIP maturata");
        assertEq(vault.claimable(TCHIP_MINTER, NVDA), 0.025e18, "meta' NVDA maturata");
        assertEq(IERC20(TCHIP).balanceOf(FACTORY) - factoryTchip, 500e18, "meta' TCHIP in riserva");
        assertEq(vault.pending(NVDA), 0.025e18, "l'altra meta' di NVDA aspetta");
        assertEq(address(vault).balance, 0, "collect non swappa");

        // un passante non puo' convertire ne' ricomprare
        vm.prank(passer);
        vm.expectRevert(ChipBuybackVault.NotExecutor.selector);
        vault.convert(NVDA, 0.025e18, 0, 500);
        vm.prank(passer);
        vm.expectRevert(ChipBuybackVault.NotExecutor.selector);
        vault.buyback(1, 0);

        // l'executor converte con un minimo deciso fuori (letto PRIMA del prank:
        // slot0 e' una chiamata esterna e se lo mangerebbe)
        uint256 minOut = _nvdaMinOut(0.025e18);
        vm.prank(keeper);
        vault.convert(NVDA, 0.025e18, minOut, 500);
        assertEq(vault.pending(NVDA), 0);
        assertEq(IERC20(NVDA).balanceOf(address(vault)), 0.025e18, "resta solo la NVDA del coniatore");
        uint256 eth = address(vault).balance;
        assertGt(eth, 0, "la NVDA e' diventata ETH");

        vm.prank(keeper);
        vault.buyback(eth, 1);
        uint256 rh4 = IERC20(RH4).balanceOf(FACTORY) - factoryRh4;
        assertGt(rh4, 0, "l'ETH e' diventato RH4 nella fabbrica");
        assertEq(address(vault).balance, 0);
        emit log_named_decimal_uint("RH4 dalla meta' di 0.05 NVDA", rh4, 18);

        // il claim: solo il coniatore
        vm.prank(passer);
        vm.expectRevert(ChipBuybackVault.NothingToDo.selector);
        vault.claim(TCHIP);
        address[] memory toks = new address[](2); toks[0] = TCHIP; toks[1] = NVDA;
        uint256 mT = IERC20(TCHIP).balanceOf(TCHIP_MINTER);
        uint256 mN = IERC20(NVDA).balanceOf(TCHIP_MINTER);
        vm.prank(TCHIP_MINTER);
        vault.claimMany(toks);
        assertEq(IERC20(TCHIP).balanceOf(TCHIP_MINTER) - mT, 500e18);
        assertEq(IERC20(NVDA).balanceOf(TCHIP_MINTER) - mN, 0.025e18);
        assertEq(IERC20(NVDA).balanceOf(address(vault)), 0, "il vault non trattiene nulla");
    }

    /// Fee in WETH: la quota riserva diventa ETH subito, pronta per il buyback.
    function test_wethDiventaEthSubito() public {
        deal(TCHIP, address(npm), 10e18); deal(WETH, address(npm), 0.002e18);
        npm.set(TCHIP, WETH, 10e18, 0.002e18);
        vault.collect(1);
        assertEq(address(vault).balance, 0.001e18, "meta' WETH -> ETH");
        assertEq(vault.claimable(TCHIP_MINTER, WETH), 0.001e18, "meta' WETH al coniatore, come WETH");
        uint256 before = IERC20(RH4).balanceOf(FACTORY);
        vm.prank(keeper);
        vault.buyback(0.001e18, 1);
        assertGt(IERC20(RH4).balanceOf(FACTORY), before);
        assertEq(IERC20(WETH).balanceOf(address(vault)), 0.001e18, "il WETH del coniatore e' intatto");
    }

    /// Il buyback rispetta il minimo: se il mercato non lo regge, non parte e l'ETH resta.
    function test_buybackSottoIlMinimoNonParte() public {
        vm.deal(address(vault), 0.01 ether);
        vm.prank(keeper);
        vm.expectRevert();
        vault.buyback(0.01 ether, type(uint128).max);
        assertEq(address(vault).balance, 0.01 ether);
        vm.prank(keeper);
        vm.expectRevert(ChipBuybackVault.TooMuch.selector);
        vault.buyback(1 ether, 0);
    }

    /// Ripartisce solo cio' che arriva: un secondo collect a vuoto non tocca
    /// ne' il pending ne' i claim (la falla del "saldo libero" e' chiusa).
    function test_unCollectVuotoNonRiparteNulla() public {
        deal(TCHIP, address(npm), 100e18); deal(NVDA, address(npm), 0.01e18);
        npm.set(TCHIP, NVDA, 100e18, 0.01e18);
        vault.collect(1);
        uint256 pend = vault.pending(NVDA);
        uint256 cl = vault.claimable(TCHIP_MINTER, NVDA);
        npm.set(TCHIP, NVDA, 0, 0); // stessa posizione, niente fee nuove
        vm.prank(passer);
        vault.collect(1);
        assertEq(vault.pending(NVDA), pend, "il pending non si muove");
        assertEq(vault.claimable(TCHIP_MINTER, NVDA), cl, "i claim non si muovono");
    }

    /// Una quote senza pool con WETH aspetta nel vault: convert fallisce, il
    /// pending resta intero, nulla sepolto in fabbrica.
    function test_quoteSenzaPoolAspetta() public {
        ChipToken alien = new ChipToken("Alien", "ALN", 999, 1_000_000e18, address(npm), 0, address(this));
        deal(TCHIP, address(npm), 10e18);
        npm.set(TCHIP, address(alien), 10e18, 100e18);
        uint256 fBefore = alien.balanceOf(FACTORY);
        vault.collect(1);
        assertEq(vault.pending(address(alien)), 50e18);
        assertEq(vault.claimable(TCHIP_MINTER, address(alien)), 50e18);
        assertEq(alien.balanceOf(FACTORY), fBefore, "niente sepolto in fabbrica");
        vm.prank(keeper);
        vm.expectRevert();
        vault.convert(address(alien), 50e18, 0, 500);
        assertEq(vault.pending(address(alien)), 50e18, "il pending e' intatto dopo il revert");
    }

    /// convert non puo' spendere piu' del pending: la parte del coniatore e' intoccabile.
    function test_convertNonToccaIClaim() public {
        deal(TCHIP, address(npm), 10e18); deal(NVDA, address(npm), 0.02e18);
        npm.set(TCHIP, NVDA, 10e18, 0.02e18);
        vault.collect(1);
        vm.prank(keeper);
        vm.expectRevert(ChipBuybackVault.TooMuch.selector);
        vault.convert(NVDA, 0.02e18, 0, 500); // ne aspettano solo 0.01
    }

    /// 100% riserva: nessuna quota al coniatore.
    function test_varianteCentoPerCentoRiserva() public {
        ChipBuybackVault v0 = _vault(0);
        deal(TCHIP, address(npm), 100e18); deal(WETH, address(npm), 0.001e18);
        npm.set(TCHIP, WETH, 100e18, 0.001e18);
        uint256 f = IERC20(TCHIP).balanceOf(FACTORY);
        v0.collect(1);
        assertEq(v0.claimable(TCHIP_MINTER, TCHIP), 0);
        assertEq(IERC20(TCHIP).balanceOf(FACTORY) - f, 100e18, "tutto il TCHIP in riserva");
        assertEq(address(v0).balance, 0.001e18, "tutto il WETH pronto per il buyback");
    }

    /// L'executor lo cambia solo l'owner della fabbrica; l'owner puo' anche
    /// premere i bottoni di persona.
    function test_executorLoNominaLOwnerDellaFabbrica() public {
        vm.prank(passer);
        vm.expectRevert(ChipBuybackVault.NotFactoryOwner.selector);
        vault.setExecutor(passer);
        address owner = IOwnerProbe(FACTORY).owner();
        vm.prank(owner);
        vault.setExecutor(passer);
        assertEq(vault.executor(), passer);
        vm.deal(address(vault), 0.001 ether);
        vm.prank(owner);
        vault.buyback(0.001 ether, 1); // l'owner passa comunque
    }

    function test_nessunoPuoChiamareIlCallback() public {
        vm.expectRevert(ChipBuybackVault.NotPoolManager.selector);
        vault.unlockCallback(abi.encode(uint256(1), uint256(0)));
    }
}
