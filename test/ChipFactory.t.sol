// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ChipFactory, IRH4GateArray} from "../src/ChipFactory.sol";
import {RH4GateArray} from "../src/RH4GateArray.sol";
import {ChipRenderer} from "../src/ChipRenderer.sol";
import {IChipRenderer} from "../src/ChipFactory.sol";

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
        id = factory.mint(_program(prog), ticker, ticker);
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
        factory.mint(_program("forever"), "A", "A");

        vm.prank(alice);
        uint256 id = factory.mint{value: 0.01 ether}(_program("forever"), "A", "A");
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
        uint256 id = factory.mint(prog, "GAS CHIP", "GAS");
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
        factory.mint(_program("forever"), "ALTRO NOME", "BHMT");

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
            factory.mint(_program("forever"), "X", cattive[i]);
            assertFalse(factory.tickerAvailable(cattive[i]));
        }

        // queste invece vanno bene
        vm.prank(alice);
        factory.mint(_program("forever"), "Un nome lungo quanto voglio", "RH-4");
        assertEq(factory.chipByTicker("RH-4"), 1);
    }

    /// Nome e sigla sono due cose diverse: il nome puo' essere lungo e
    /// libero, la sigla e' corta, maiuscola e unica.
    function test_nomeLungoESiglaCorta() public {
        vm.prank(alice);
        uint256 id = factory.mint(
            _program("forever"),
            "Behemoth Mark II",
            "BHMT2"
        );
        ChipFactory.Chip memory c = factory.chip(id);
        assertEq(c.label, bytes32("Behemoth Mark II"));
        assertEq(c.ticker, bytes32("BHMT2"));
    }

    // ---- l'immagine ---------------------------------------------------------

    /// L'NFT non e' un puntatore a un PNG su un server: e' un SVG costruito
    /// dai 79 bit veri. Questo test lo scrive su disco cosi' si puo' guardare.
    function test_tokenURIEsceUnSvgValido() public {
        factory.setRenderer(IChipRenderer(address(new ChipRenderer())));
        vm.prank(alice);
        uint256 id = factory.mint(_program("forever"), "Behemoth", "BHMT");

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
        uint256 id = factory.mint(_program("forever"), bytes32('<script>x</script>'), "EVIL");
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
