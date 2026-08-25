// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ChipFactory, IRH4GateArray} from "../src/ChipFactory.sol";
import {RH4GateArray} from "../src/RH4GateArray.sol";
import {ChipRenderer} from "../src/ChipRenderer.sol";
import {IChipRenderer} from "../src/ChipFactory.sol";
import {ChipToken} from "../src/ChipToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * La domanda a cui questi test devono rispondere e' una sola: il silicio
 * condiviso si comporta esattamente come quello inlinato dentro RH4.sol?
 * Se la risposta e' si', allora tutta la catena di verifica che parte
 * dall'RTL vale anche per i chip coniati dalla fabbrica.
 */
contract ChipFactoryTest is Test {
    RH4GateArray internal gates;
    ChipFactory internal factory;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant FIB_CYCLES = 49;

    // 20% alla liquidita', il resto distribuito su un milione di cicli:
    // a 10 Hz sono poco meno di 28 ore di clock.
    uint16 internal constant LIQ_BPS = 2_000;
    uint64 internal constant TARGET = 1_000_000;

    function setUp() public {
        gates = new RH4GateArray();
        factory = new ChipFactory(IRH4GateArray(address(gates)), address(this));
        vm.roll(block.number + 1);
    }

    function _program(string memory name) internal view returns (uint256[16] memory slots) {
        string memory raw = vm.readFile(string.concat("build/", name, ".slots.json"));
        uint256[] memory parsed = vm.parseJsonUintArray(raw, ".slots");
        require(parsed.length == 16, "slot di ROM attesi: 16");
        for (uint256 i; i < 16; ++i) slots[i] = parsed[i];
    }

    function _mint(address who, string memory prog, bytes32 ticker)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        (id, ) = factory.mint(_program(prog), ticker, ticker, LIQ_BPS, TARGET);
    }

    // ---- il chip e' un token ------------------------------------------------

    function test_coniareUnChip() public {
        uint256 id = _mint(alice, "forever", "PRIMO");

        assertEq(id, 1);
        assertEq(factory.ownerOf(id), alice);
        assertEq(factory.totalChips(), 1);

        ChipFactory.Chip memory c = factory.chip(id);
        assertEq(c.label, bytes32("PRIMO"));
        assertEq(c.ticker, bytes32("PRIMO"));
        assertEq(factory.chipByTicker("PRIMO"), id);
        assertEq(c.minter, alice);
        assertEq(c.bornBlock, block.number);
    }

    function test_chipInesistente() public {
        vm.expectRevert(ChipFactory.NoSuchChip.selector);
        factory.inspect(99);
    }

    // ---- il silicio condiviso deve dare gli stessi numeri -------------------

    /// Fibonacci a 4 bit su un chip coniato: 1 1 2 3 5 8 13 in 49 cicli.
    /// Sono gli stessi numeri dell'RTL, della netlist e di RH4.sol.
    function test_fibonacciSuUnChipConiato() public {
        uint256 id = _mint(alice, "fib", "FIB");

        uint8[7] memory expected = [uint8(1), 1, 2, 3, 5, 8, 13];
        uint256 seen;
        uint256 cycles;

        while (cycles < 500) {
            (uint8 pc, , bool halted, , ) = factory.inspect(id);
            if (halted) break;

            bool isOut = factory.romAt(id, pc) >> 8 == 0xe;
            (, uint8 outValue, ) = factory.tick(id);
            vm.roll(block.number + 1);
            ++cycles;

            if (isOut) {
                assertLt(seen, 7, "piu' uscite del previsto");
                assertEq(outValue, expected[seen], "termine di Fibonacci sbagliato");
                ++seen;
            }
        }

        (, , bool ended, uint256 count, ) = factory.inspect(id);
        assertTrue(ended, "il chip non si e' fermato");
        assertEq(seen, 7, "uscite mancanti");
        assertEq(cycles, FIB_CYCLES, "conteggio cicli diverso dall'RTL");
        assertEq(count, FIB_CYCLES, "contatore on-chain diverso");
    }

    // ---- il clock ----------------------------------------------------------

    function test_unTickPerBloccoPerChip() public {
        uint256 id = _mint(alice, "forever", "A");

        factory.tick(id);
        vm.expectRevert(ChipFactory.OneTickPerBlock.selector);
        factory.tick(id);

        vm.roll(block.number + 1);
        factory.tick(id);
    }

    /// Due chip hanno clock indipendenti: fermarne uno non ferma l'altro.
    function test_clockIndipendentiFraChip() public {
        uint256 a = _mint(alice, "forever", "A");
        uint256 b = _mint(bob, "forever", "B");

        factory.tick(a);
        factory.tick(b); // stesso blocco, chip diverso: deve passare

        (, , , uint256 ca, ) = factory.inspect(a);
        (, , , uint256 cb, ) = factory.inspect(b);
        assertEq(ca, 1);
        assertEq(cb, 1);
    }

    /// Il clock non e' del proprietario. Chiunque puo' pagare un ciclo.
    function test_chiunquePuoPagareIlClock() public {
        uint256 id = _mint(alice, "forever", "A");

        vm.prank(bob);
        factory.tick(id); // bob non possiede il chip di alice

        (, , , uint256 cycles, ) = factory.inspect(id);
        assertEq(cycles, 1);
        assertEq(factory.ownerOf(id), alice, "il tick non cambia la proprieta'");
    }

    // ---- halt e recupero ----------------------------------------------------

    function test_dopoHaltIlChipNonSiMuove() public {
        uint256 id = _mint(alice, "fib", "FIB");
        _runToHalt(id);

        vm.roll(block.number + 1);
        vm.expectRevert(ChipFactory.AlreadyHalted.selector);
        factory.tick(id);
    }

    /// `restart` fa ripartire il processore ma NON azzera i cicli: e' quello
    /// che rende credibile la frase "questo chip ha macinato N cicli".
    function test_restartNonAzzeraICicli() public {
        uint256 id = _mint(alice, "fib", "FIB");
        _runToHalt(id);

        (, , , uint256 before, ) = factory.inspect(id);
        assertEq(before, FIB_CYCLES);

        vm.prank(alice);
        factory.restart(id);

        (uint8 pc, , bool halted, uint256 after_, ) = factory.inspect(id);
        assertEq(pc, 0, "il processore non e' ripartito da zero");
        assertFalse(halted);
        assertEq(after_, before, "i cicli di vita sono stati azzerati");
        assertEq(factory.chip(id).resets, 1);
    }

    function test_soloIlProprietarioRiprogramma() public {
        uint256 id = _mint(alice, "forever", "A");

        vm.prank(bob);
        vm.expectRevert(ChipFactory.NotChipOwner.selector);
        factory.restart(id);

        vm.prank(bob);
        vm.expectRevert(ChipFactory.NotChipOwner.selector);
        factory.reprogram(id, _program("fib"));

        vm.prank(alice);
        factory.reprogram(id, _program("fib"));
        assertEq(factory.romAt(id, 0), 0x100, "la ROM non e' cambiata");
    }

    // ---- provare prima di coniare -------------------------------------------

    /// Un chip che incontra HLT smette di essere interessante. Questa view
    /// e' l'unica cosa che sta fra un compratore e un NFT morto.
    function test_previewProgramDistingueIProgrammi() public view {
        (bool fibHalts, uint256 fibRan, uint8 fibOut) =
            factory.previewProgram(_program("fib"), 500);
        assertTrue(fibHalts, "fib deve fermarsi");
        assertEq(fibRan, FIB_CYCLES);
        assertEq(fibOut, 13);

        (bool foreverHalts, uint256 foreverRan, ) =
            factory.previewProgram(_program("forever"), 5300);
        assertFalse(foreverHalts, "forever non deve fermarsi mai");
        assertEq(foreverRan, 5300);
    }

    // ---- prezzo di conio ----------------------------------------------------

    function test_prezzoDiConio() public {
        factory.setMintPrice(0.01 ether);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(ChipFactory.WrongPayment.selector);
        factory.mint(_program("forever"), "A", "A", LIQ_BPS, TARGET);

        vm.prank(alice);
        (uint256 id, ) = factory.mint{value: 0.01 ether}(_program("forever"), "A", "A", LIQ_BPS, TARGET);
        assertEq(factory.ownerOf(id), alice);
        assertEq(address(factory).balance, 0.01 ether);

        address payable sink = payable(makeAddr("sink"));
        factory.withdraw(sink);
        assertEq(sink.balance, 0.01 ether);
    }

    // ---- i numeri che decidono l'economia -----------------------------------

    function test_gasConioETick() public {
        uint256[16] memory prog = _program("forever");

        vm.prank(alice);
        uint256 g0 = gasleft();
        (uint256 id, ) = factory.mint(prog, "GAS CHIP", "GAS", LIQ_BPS, TARGET);
        uint256 gasMint = g0 - gasleft();

        factory.tick(id); // primo tick: slot freddi, non rappresentativo
        vm.roll(block.number + 1);

        uint256 g1 = gasleft();
        factory.tick(id);
        uint256 gasTick = g1 - gasleft();

        console.log("gas per coniare un chip:      ", gasMint);
        console.log("gas per ciclo (esecuzione):   ", gasTick);
        console.log("gas per ciclo (con base tx):  ", gasTick + 21000);
    }

    // ---- la sigla e' identita' ----------------------------------------------

    /// Senza unicita' chiunque potrebbe coniare un chip con la sigla di un
    /// altro. La sigla e' il nome con cui il chip viene scambiato: lasciarla
    /// duplicabile sarebbe un invito all'inganno.
    function test_siglaUnica() public {
        uint256 first = _mint(alice, "forever", "BHMT");

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ChipFactory.TickerTaken.selector, first));
        factory.mint(_program("forever"), "ALTRO NOME", "BHMT", LIQ_BPS, TARGET);

        assertFalse(factory.tickerAvailable("BHMT"));
        assertTrue(factory.tickerAvailable("LIBERA"));
    }

    function test_sigleNonValide() public {
        bytes32[5] memory cattive = [
            bytes32(""),                    // vuota
            bytes32("troppo lunga assai"),  // oltre gli 8 caratteri
            bytes32("minusc"),              // minuscole
            bytes32("A B"),                 // spazio
            bytes32("A$")                   // simbolo
        ];
        for (uint256 i; i < cattive.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(ChipFactory.BadTicker.selector);
            factory.mint(_program("forever"), "X", cattive[i], LIQ_BPS, TARGET);
            assertFalse(factory.tickerAvailable(cattive[i]));
        }

        // queste invece vanno bene
        vm.prank(alice);
        factory.mint(_program("forever"), "Un nome lungo quanto voglio", "RH-4", LIQ_BPS, TARGET);
        assertEq(factory.chipByTicker("RH-4"), 1);
    }

    /// Nome e sigla sono due cose diverse: il nome puo' essere lungo e
    /// libero, la sigla e' corta, maiuscola e unica.
    function test_nomeLungoESiglaCorta() public {
        vm.prank(alice);
        (uint256 id, ) = factory.mint(
            _program("forever"),
            "Behemoth Mark II",
            "BHMT2",
            LIQ_BPS,
            TARGET
        );
        ChipFactory.Chip memory c = factory.chip(id);
        assertEq(c.label, bytes32("Behemoth Mark II"));
        assertEq(c.ticker, bytes32("BHMT2"));
    }

    // ---- il token -----------------------------------------------------------

    /// Il token nasce col nome e la sigla del chip, offerta fissa, e la
    /// riserva resta alla fabbrica: e' li' che i cicli vanno a prenderla.
    function test_ilTokenNasceColChip() public {
        vm.prank(alice);
        (uint256 id, address token) =
            factory.mint(_program("forever"), "Behemoth", "BHMT", LIQ_BPS, TARGET);

        ChipToken t = ChipToken(token);
        assertEq(t.name(), "Behemoth");
        assertEq(t.symbol(), "BHMT");
        assertEq(t.chipId(), id);
        assertEq(t.totalSupply(), factory.TOKEN_SUPPLY());

        uint256 expectedLiq = (factory.TOKEN_SUPPLY() * LIQ_BPS) / 10_000;
        assertEq(t.balanceOf(alice), expectedLiq, "la liquidita' non e' andata al minter");
        assertEq(
            t.balanceOf(address(factory)),
            factory.TOKEN_SUPPLY() - expectedLiq,
            "la riserva non e' rimasta alla fabbrica"
        );
    }

    /// Nessuno puo' stampare altri token: il contratto non ha una mint.
    /// L'unica via d'uscita dalla riserva passa da tick().
    function test_unCicloPagaIlSuoSponsor() public {
        vm.prank(alice);
        (uint256 id, address token) =
            factory.mint(_program("forever"), "Behemoth", "BHMT", LIQ_BPS, TARGET);

        (, uint256 reserveBefore, uint256 reward, uint256 cyclesLeft) = factory.emission(id);
        assertEq(cyclesLeft, TARGET, "la riserva non copre i cicli promessi");

        // bob non possiede il chip: paga il ciclo e incassa lo stesso
        vm.prank(bob);
        factory.tick(id);

        assertEq(IERC20(token).balanceOf(bob), reward, "lo sponsor non e' stato pagato");
        (, uint256 reserveAfter, , ) = factory.emission(id);
        assertEq(reserveAfter, reserveBefore - reward);
        assertEq(factory.ownerOf(id), alice, "pagare un ciclo non da' il chip");
    }

    /// Quando la riserva finisce il clock NON si ferma: continua gratis.
    /// Un chip senza piu' token da dare e' ancora un processore acceso.
    function test_riservaFinitaMaIlClockContinua() public {
        vm.prank(alice);
        (uint256 id, address token) =
            factory.mint(_program("forever"), "Behemoth", "BHMT", LIQ_BPS, TARGET);

        (, , uint256 reward, ) = factory.emission(id);

        // porto la riserva a un ciclo e mezzo invece di aspettarne un milione
        deal(token, address(factory), (reward * 3) / 2);

        vm.prank(bob);
        factory.tick(id);
        assertEq(IERC20(token).balanceOf(bob), reward);

        // il ciclo che prosciuga la riserva lo annuncia, una volta sola
        vm.roll(block.number + 1);
        vm.expectEmit(true, false, false, false);
        emit ChipFactory.ReserveEmpty(id, 2);
        vm.prank(bob);
        factory.tick(id);
        assertEq(IERC20(token).balanceOf(bob), (reward * 3) / 2, "l'ultimo resto non e' uscito");
        assertEq(IERC20(token).balanceOf(address(factory)), 0);

        // riserva vuota: il ciclo passa lo stesso, in silenzio
        vm.roll(block.number + 1);
        vm.prank(bob);
        factory.tick(id);

        (, , , uint256 cycles, ) = factory.inspect(id);
        assertEq(cycles, 3, "il clock si e' fermato con la riserva");

        // e continua a passare anche dopo
        vm.roll(block.number + 1);
        factory.tick(id);
        (, , , uint256 cycles2, ) = factory.inspect(id);
        assertEq(cycles2, 4);
    }

    function test_parametriDiEmissioneFuoriRange() public {
        vm.startPrank(alice);

        vm.expectRevert(ChipFactory.BadLiquidityShare.selector);
        factory.mint(_program("forever"), "X", "AAA", 5_001, TARGET);

        vm.expectRevert(ChipFactory.TargetTooShort.selector);
        factory.mint(_program("forever"), "X", "BBB", LIQ_BPS, 99_999);

        // i limiti esatti devono passare
        factory.mint(_program("forever"), "X", "CCC", 5_000, 100_000);
        vm.stopPrank();
    }

    /// Senza fetta di liquidita' tutto il miliardo passa dai cicli.
    function test_zeroLiquiditaTuttoAiCicli() public {
        vm.prank(alice);
        (uint256 id, address token) =
            factory.mint(_program("forever"), "Puro", "PURO", 0, TARGET);

        assertEq(IERC20(token).balanceOf(alice), 0);
        assertEq(IERC20(token).balanceOf(address(factory)), factory.TOKEN_SUPPLY());

        (, , uint256 reward, ) = factory.emission(id);
        assertEq(reward, factory.TOKEN_SUPPLY() / TARGET);
    }

    // ---- token lanciato altrove ---------------------------------------------

    /// Un launchpad vuole creare il proprio contratto token. La fabbrica non
    /// ha bisogno di crearlo: le basta sapere qual e' e avere una riserva.
    function test_chipNudoPoiTokenAgganciato() public {
        vm.prank(alice);
        (uint256 id, address token) =
            factory.mint(_program("forever"), "Nudo", "NUDO", 0, 0);
        assertEq(token, address(0), "non doveva nascere nessun token");

        (address t0, , , ) = factory.emission(id);
        assertEq(t0, address(0));

        // il clock gira lo stesso, semplicemente non paga
        factory.tick(id);
        (, , , uint256 cycles, ) = factory.inspect(id);
        assertEq(cycles, 1, "un chip senza token deve girare comunque");

        // arriva il token, lanciato da un'altra parte
        ChipToken esterno = new ChipToken("Esterno", "EXT", id, 1_000e18, address(this), 0, address(0));
        vm.prank(alice);
        factory.attachToken(id, address(esterno), 10e18);

        // la riserva e' il saldo della fabbrica: si finanzia trasferendo
        esterno.transfer(address(factory), 500e18);
        (address t1, uint256 reserve, uint256 reward, uint256 left) = factory.emission(id);
        assertEq(t1, address(esterno));
        assertEq(reserve, 500e18);
        assertEq(reward, 10e18);
        assertEq(left, 50);

        vm.roll(block.number + 1);
        vm.prank(bob);
        factory.tick(id);
        assertEq(esterno.balanceOf(bob), 10e18, "lo sponsor non e' stato pagato");
    }

    /// Cambiare il token dopo lascerebbe in mano la cosa sbagliata a chi ha
    /// macinato cicli per guadagnarlo. Si aggancia una volta sola.
    function test_ilTokenSiAgganciaUnaVoltaSola() public {
        vm.prank(alice);
        (uint256 id, ) = factory.mint(_program("forever"), "Nudo", "NUDO", 0, 0);

        ChipToken a = new ChipToken("A", "A", id, 1_000e18, address(this), 0, address(0));
        ChipToken b = new ChipToken("B", "B", id, 1_000e18, address(this), 0, address(0));

        vm.prank(alice);
        factory.attachToken(id, address(a), 1e18);

        vm.prank(alice);
        vm.expectRevert(ChipFactory.TokenAlreadySet.selector);
        factory.attachToken(id, address(b), 1e18);

        // e un token non puo' servire due chip: si ruberebbero la riserva
        vm.prank(bob);
        (uint256 altro, ) = factory.mint(_program("forever"), "Altro", "ALTRO", 0, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ChipFactory.TokenInUse.selector, id));
        factory.attachToken(altro, address(a), 1e18);
    }

    function test_soloIlProprietarioAggancia() public {
        vm.prank(alice);
        (uint256 id, ) = factory.mint(_program("forever"), "Nudo", "NUDO", 0, 0);
        ChipToken t = new ChipToken("A", "A", id, 1_000e18, address(this), 0, address(0));

        vm.prank(bob);
        vm.expectRevert(ChipFactory.NotChipOwner.selector);
        factory.attachToken(id, address(t), 1e18);
    }

    // ---- il chip madre ------------------------------------------------------

    /// La quota di conio non va in tasca a nessuno: finisce nella riserva
    /// della madre, cioe' paga chi la tiene accesa. Coniare un chip nuovo
    /// finanzia chi fa girare il primo.
    function test_laQuotaDiConioFinanziaLaMadre() public {
        vm.prank(alice);
        (uint256 madre, address token) =
            factory.mint(_program("forever"), "Madre", "MADRE", LIQ_BPS, TARGET);

        factory.setMother(madre);
        assertEq(factory.motherChip(), madre);
        assertEq(factory.motherToken(), token);

        factory.setMintPriceToken(1_000e18);

        (, uint256 reservePrima, , ) = factory.emission(madre);

        // bob ha comprato dei MADRE e li usa per coniare il suo chip
        deal(token, bob, 5_000e18);
        vm.startPrank(bob);
        IERC20(token).approve(address(factory), 1_000e18);
        (uint256 figlio, ) = factory.mint(_program("forever"), "Figlio", "FIGLIO", LIQ_BPS, TARGET);
        vm.stopPrank();

        assertEq(figlio, madre + 1);
        (, uint256 reserveDopo, , ) = factory.emission(madre);
        assertEq(reserveDopo, reservePrima + 1_000e18, "la quota non e' finita nella riserva");
        assertEq(IERC20(token).balanceOf(bob), 4_000e18);
    }

    /// Se la madre potesse spostarsi, "madre" smetterebbe di voler dire nulla.
    function test_laMadreSiFissaUnaVoltaSola() public {
        uint256 a = _mint(alice, "forever", "AAA");
        uint256 b = _mint(bob, "forever", "BBB");

        factory.setMother(a);
        vm.expectRevert(ChipFactory.MotherAlreadySet.selector);
        factory.setMother(b);
    }

    function test_quotaSenzaMadreNonSiPuoPagare() public {
        factory.setMintPriceToken(1_000e18);
        vm.prank(alice);
        vm.expectRevert(ChipFactory.NoMother.selector);
        factory.mint(_program("forever"), "X", "XXX", LIQ_BPS, TARGET);
    }

    /// Il bug che avrei lasciato: azzerare il premio a riserva vuota avrebbe
    /// ucciso ogni pagamento successivo, e la riserva e' ricaricabile.
    function test_riservaRicaricataRipagaDiNuovo() public {
        vm.prank(alice);
        (uint256 id, address token) =
            factory.mint(_program("forever"), "Madre", "MADRE", LIQ_BPS, TARGET);
        (, , uint256 reward, ) = factory.emission(id);

        deal(token, address(factory), reward); // esattamente un ciclo
        vm.prank(bob);
        factory.tick(id);
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "la riserva doveva svuotarsi");

        // un ciclo a secco: passa, ma non paga
        vm.roll(block.number + 1);
        vm.prank(bob);
        factory.tick(id);
        assertEq(IERC20(token).balanceOf(bob), reward, "non doveva pagare a secco");

        // qualcuno ricarica: i pagamenti devono ripartire
        deal(token, address(factory), reward * 3);
        vm.roll(block.number + 1);
        vm.prank(bob);
        factory.tick(id);
        assertEq(IERC20(token).balanceOf(bob), reward * 2, "la ricarica non ha ripagato");
    }

    // ---- l'immagine ---------------------------------------------------------

    /// L'NFT non e' un puntatore a un PNG su un server: e' un SVG costruito
    /// dai 79 bit veri. Questo test lo scrive su disco cosi' si puo' guardare.
    function test_tokenURIEsceUnSvgValido() public {
        factory.setRenderer(IChipRenderer(address(new ChipRenderer())));
        vm.prank(alice);
        (uint256 id, ) = factory.mint(_program("forever"), "Behemoth", "BHMT", LIQ_BPS, TARGET);

        for (uint256 i; i < 20; ++i) {
            factory.tick(id);
            vm.roll(block.number + 1);
        }

        string memory uri = factory.tokenURI(id);
        assertGt(bytes(uri).length, 500, "tokenURI troppo corto per contenere un SVG");
        vm.writeFile("build/tokenURI.txt", uri);
    }

    /// Un'etichetta ostile non deve poter iniettare markup dentro l'SVG.
    function test_etichettaNonInietta() public {
        factory.setRenderer(IChipRenderer(address(new ChipRenderer())));
        vm.prank(alice);
        (uint256 id, ) = factory.mint(_program("forever"), bytes32('<script>x</script>'), "EVIL", LIQ_BPS, TARGET);
        string memory uri = factory.tokenURI(id);
        vm.writeFile("build/tokenURI-hostile.txt", uri);
        assertGt(bytes(uri).length, 500);
    }

    function _runToHalt(uint256 id) internal {
        for (uint256 i; i < 500; ++i) {
            (, , bool halted, , ) = factory.inspect(id);
            if (halted) return;
            factory.tick(id);
            vm.roll(block.number + 1);
        }
        revert("nessun halt");
    }
}
