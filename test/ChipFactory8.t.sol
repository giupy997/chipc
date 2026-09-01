// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ChipFactory8, IRH8GateArray} from "../src/ChipFactory8.sol";
import {RH8GateArray} from "../src/RH8Gates.sol";
import {ChipToken} from "../src/ChipToken.sol";
import {Chip8Renderer} from "../src/Chip8Renderer.sol";
import {IChip8Renderer} from "../src/ChipFactory8.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * La catena di verifica ha quattro anelli e devono dire tutti la stessa
 * cosa: simulazione RTL, netlist sintetizzata, interprete isolato, e qui —
 * un chip vero coniato da una fabbrica vera.
 *
 * Se qui esce un numero diverso da quello del banco Verilog, ha torto il
 * contratto, non il silicio.
 */
contract ChipFactory8Test is Test {
    RH8GateArray internal gates;
    ChipFactory8 internal factory;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint16 internal constant LIQ_BPS = 2_000;
    uint64 internal constant TARGET = 1_000_000;

    function setUp() public {
        gates = new RH8GateArray();
        factory = new ChipFactory8(IRH8GateArray(address(gates)), address(this));
        vm.roll(block.number + 1);
    }

    /// Lo stesso programma del banco Verilog, impacchettato come lo vuole
    /// il costruttore: otto parole da 25 bit per slot, in corsie da 32.
    function _program() internal pure returns (uint256[128] memory rom) {
        uint32[16] memory w = [
            uint32(0x1500000), // IN   r0
            0x0110020,         // LDI  r1, #0x20
            0x1410000,         // ST   [r1], r0
            0x0100000,         // LDI  r0, #0
            0x1321000,         // LD   r2, [r1]
            0x0000000,         // NOP      la load si chiude qui
            0x1620000,         // OUT  r2
            0x01300C8,         // LDI  r3, #200
            0x0140064,         // LDI  r4, #100
            0x0334000,         // ADD  r3, r4
            0x1630000,         // OUT  r3
            0x1A0000D,         // JC   13
            0x1C00000,         // HLT
            0x01500FF,         // LDI  r5, #255
            0x1650000,         // OUT  r5
            0x1C00000          // HLT
        ];
        for (uint256 i; i < 16; ++i) {
            rom[i >> 3] |= uint256(w[i]) << ((i & 7) * 32);
        }
    }

    function _mint(address who, bytes32 ticker) internal returns (uint256 id, address token) {
        vm.prank(who);
        (id, token) = factory.mint(_program(), ticker, ticker, "", LIQ_BPS, TARGET);
    }

    // ---- l'anello finale della catena ---------------------------------------

    /// Gli stessi tre numeri, allo stesso ciclo, con lo stesso byte in RAM.
    function test_stessiNumeriDelSilicio() public {
        (uint256 id, ) = _mint(alice, "RH8");

        uint8[3] memory expected = [uint8(165), 44, 255];
        uint256 seen;
        uint256 cycles;

        while (cycles < 200) {
            (uint16 pc, , bool halted, , ) = factory.inspect(id);
            if (halted) break;
            bool isOut = factory.romAt(id, pc) >> 20 == 22;

            factory.tick(id, 0xA5);
            vm.roll(block.number + 1);
            ++cycles;

            if (isOut) {
                (, uint8 out, , , ) = factory.inspect(id);
                assertEq(out, expected[seen], "uscita diversa dal silicio");
                ++seen;
            }
        }

        (uint16 endPc, , bool ended, uint256 count, ) = factory.inspect(id);
        assertTrue(ended, "il chip non si e' fermato");
        assertEq(seen, 3, "uscite mancanti");
        assertEq(cycles, 15, "conteggio cicli diverso dall'RTL");
        assertEq(count, cycles, "il contatore on-chain non segue i cicli");
        assertEq(endPc, 15, "fermo nel posto sbagliato: carry mancato?");
        assertEq(factory.ramAt(id, 0x20), 165, "il byte non e' arrivato in RAM");
    }

    /// Cio' che la generazione a 4 bit non poteva fare: ricevere qualcosa.
    /// Stesso programma, stesso chip, ingressi diversi, uscite diverse.
    function test_lIngressoCambiaIlRisultato() public {
        uint8[3] memory inputs = [uint8(1), 200, 255];

        for (uint256 i; i < 3; ++i) {
            (uint256 id, ) = _mint(alice, bytes32(uint256(0x41 + i) << 248));
            for (uint256 c; c < 8; ++c) {
                factory.tick(id, inputs[i]);
                vm.roll(block.number + 1);
            }
            (, uint8 out, , , ) = factory.inspect(id);
            assertEq(out, inputs[i], "l'uscita non segue l'ingresso");
            assertEq(factory.ramAt(id, 0x20), inputs[i], "la RAM non ha ricevuto il byte");
        }
    }

    /// La RAM e' del chip, non della fabbrica: due chip non si toccano.
    function test_ramSeparataFraChip() public {
        (uint256 a, ) = _mint(alice, "AAA");
        (uint256 b, ) = _mint(bob, "BBB");

        for (uint256 c; c < 8; ++c) {
            factory.tick(a, 111);
            factory.tick(b, 222);
            vm.roll(block.number + 1);
        }
        assertEq(factory.ramAt(a, 0x20), 111);
        assertEq(factory.ramAt(b, 0x20), 222);
    }

    /// Il giro completo del PC a 10 bit: 0x3FF + 1 = 0x000, attraverso i
    /// gate, non per convenzione dell'interprete. Chiesto da un revisore
    /// esterno il giorno del lancio — aveva ragione a chiederlo.
    function test_ilPcFaIlGiroCompleto() public {
        uint256[128] memory rom;
        rom[0] = 0x17003FF;                          // jmp 0x3FF
        rom[127] |= uint256(0x0110011) << (7 * 32);  // ROM[1023]: ldi r1, #0x11

        vm.prank(alice);
        (uint256 id, ) = factory.mint(rom, "WRAP", "WRAP", "", 0, 0);

        factory.tick(id, 0);
        vm.roll(block.number + 1);
        (uint16 pc, , , , ) = factory.inspect(id);
        assertEq(pc, 0x3FF, "il salto all'ultima parola non e' arrivato");

        factory.tick(id, 0);
        vm.roll(block.number + 1);
        (pc, , , , ) = factory.inspect(id);
        assertEq(pc, 0, "il PC non ha fatto il giro: 0x3FF+1 deve essere 0");

        factory.tick(id, 0);
        vm.roll(block.number + 1);
        (pc, , , , ) = factory.inspect(id);
        assertEq(pc, 0x3FF, "dopo il giro il programma deve continuare da ROM[0]");
    }

    // ---- il clock ------------------------------------------------------------

    function test_unTickPerBloccoPerChip() public {
        (uint256 id, ) = _mint(alice, "CLK");
        factory.tick(id, 0);
        vm.expectRevert(ChipFactory8.OneTickPerBlock.selector);
        factory.tick(id, 0);
        vm.roll(block.number + 1);
        factory.tick(id, 0);
    }

    function test_chiunquePagaEIncassa() public {
        (uint256 id, address token) = _mint(alice, "PAY");
        (, , uint256 reward, ) = factory.emission(id);

        vm.prank(bob);
        factory.tick(id, 0);

        assertEq(IERC20(token).balanceOf(bob), reward, "lo sponsor non e' stato pagato");
        assertEq(factory.ownerOf(id), alice, "pagare un ciclo non da' il chip");
    }

    /// `restart` azzera la RAM ma non i cicli di vita: uno e' stato,
    /// l'altro e' storia.
    function test_restartAzzeraLaRamNonLaStoria() public {
        (uint256 id, ) = _mint(alice, "RST");
        for (uint256 c; c < 8; ++c) {
            factory.tick(id, 77);
            vm.roll(block.number + 1);
        }
        assertEq(factory.ramAt(id, 0x20), 77);

        vm.prank(alice);
        factory.restart(id);

        (uint16 pc, , , uint256 cycles, ) = factory.inspect(id);
        assertEq(pc, 0, "il processore non e' ripartito");
        assertEq(cycles, 8, "i cicli di vita sono stati azzerati");
        assertEq(factory.ramAt(id, 0x20), 0, "la RAM non e' stata azzerata");
    }

    /// Il programma di mainnet, quello vero assemblato da asm/echo8.asm,
    /// dentro l'EVM: non si ferma, fa eco, accumula in RAM.
    function test_echo8NonSiFermaEAscolta() public {
        string memory raw = vm.readFile("build/echo8.slots8.json");
        uint256[] memory parsed = vm.parseJsonUintArray(raw, ".slots");
        uint256[128] memory rom;
        for (uint256 i; i < 128; ++i) rom[i] = parsed[i];

        vm.prank(alice);
        (uint256 id, ) = factory.mint(rom, "Echo", "ECHO", "", LIQ_BPS, TARGET);

        for (uint256 c; c < 90; ++c) {
            factory.tick(id, 7);
            vm.roll(block.number + 1);
        }
        (, uint8 out, bool halted, uint256 cycles, ) = factory.inspect(id);
        assertFalse(halted, "il programma di mainnet si e' fermato");
        assertEq(cycles, 90);
        // 90 cicli / 9 per giro = 10 giri: l'accumulatore ha sentito 7 dieci volte
        assertEq(factory.ramAt(id, 0x10), 70, "l'accumulatore in RAM non torna");
        assertEq(out, 70, "l'ultima uscita non e' la somma");
    }

    /// L'NFT si disegna: logo come image, card viva come animation_url,
    /// e le otto luci vengono dai bit veri.
    function test_tokenURIConLogo() public {
        factory.setRenderer(IChip8Renderer(address(new Chip8Renderer("https://rh4.example/"))));
        vm.prank(alice);
        (uint256 id, ) = factory.mint(
            _program(), "RH4 CPU", "RH4X",
            "ipfs://bafkreiabcdefghijklmnopqrstuvwxyz234567", LIQ_BPS, TARGET
        );
        for (uint256 c; c < 8; ++c) {
            factory.tick(id, 0xA5);
            vm.roll(block.number + 1);
        }
        string memory uri = factory.tokenURI(id);
        assertGt(bytes(uri).length, 500);
        vm.writeFile("build/tokenURI-rh8.txt", uri);
    }

    /// Il 60% alla liquidita' passa, il 61% no.
    function test_tettoLiquiditaAl60() public {
        vm.prank(alice);
        factory.mint(_program(), "L60", "L60", "", 6_000, TARGET);

        vm.prank(alice);
        vm.expectRevert(ChipFactory8.BadLiquidityShare.selector);
        factory.mint(_program(), "L61", "L61", "", 6_001, TARGET);
    }

    /// owner() del token = proprietario dell'NFT del chip, e segue i
    /// trasferimenti. E' una vista per gli explorer, non un potere.
    function test_ownerDelTokenSegueIlChip() public {
        (uint256 id, address token) = _mint(alice, "OWN");
        assertEq(ChipToken(token).owner(), alice);

        vm.prank(alice);
        factory.transferFrom(alice, bob, id);
        assertEq(ChipToken(token).owner(), bob, "owner() non segue l'NFT");
    }

    // ---- token nato altrove (launchpad) --------------------------------------

    /// Un chip nudo + un token qualsiasi: la riserva si finanzia PRIMA,
    /// l'aggancio dopo, e da li' il mining funziona come coi nostri token.
    function test_agganciaTokenDiUnLaunchpad() public {
        vm.prank(alice);
        (uint256 id, address none) = factory.mint(_program(), "PONS", "PONS", "", 0, 0);
        assertEq(none, address(0), "un chip nudo non deve avere token");

        ChipToken ext = new ChipToken("Altrove", "ALT", 999, 1_000_000e18, address(this), 1_000_000e18, address(this));
        ext.transfer(address(factory), 400_000e18);

        vm.prank(alice);
        factory.attachToken(id, address(ext), 5e18);

        vm.prank(bob);
        factory.tick(id, 0);
        assertEq(ext.balanceOf(bob), 5e18, "lo sponsor non e' stato pagato col token esterno");

        (address t, uint256 left, uint256 reward, ) = factory.emission(id);
        assertEq(t, address(ext));
        assertEq(left, 400_000e18 - 5e18);
        assertEq(reward, 5e18);
    }

    /// La trappola disinnescata: senza riserva l'aggancio deve fallire,
    /// perche' un tick a riserva vuota spegnerebbe l'emissione per sempre.
    function test_nienteAggancioARisevaVuota() public {
        vm.prank(alice);
        (uint256 id, ) = factory.mint(_program(), "VUOTO", "VUOTO", "", 0, 0);
        ChipToken ext = new ChipToken("Altrove", "ALT2", 999, 1_000_000e18, address(this), 1_000_000e18, address(this));

        vm.prank(alice);
        vm.expectRevert(ChipFactory8.ReserveNotFunded.selector);
        factory.attachToken(id, address(ext), 5e18);
    }

    function test_aggancioUnaVoltaSola() public {
        (uint256 id, address token) = _mint(alice, "GIA");
        assertTrue(token != address(0));

        ChipToken ext = new ChipToken("Altrove", "ALT3", 999, 1_000_000e18, address(this), 1_000_000e18, address(this));
        ext.transfer(address(factory), 1e18);

        vm.prank(alice);
        vm.expectRevert(ChipFactory8.TokenAlreadySet.selector);
        factory.attachToken(id, address(ext), 1e18);
    }

    function test_unTokenNonServeDueChip() public {
        vm.prank(alice);
        (uint256 a, ) = factory.mint(_program(), "UNO", "UNO", "", 0, 0);
        vm.prank(alice);
        (uint256 b, ) = factory.mint(_program(), "DUE", "DUE", "", 0, 0);

        ChipToken ext = new ChipToken("Altrove", "ALT4", 999, 1_000_000e18, address(this), 1_000_000e18, address(this));
        ext.transfer(address(factory), 2e18);

        vm.prank(alice);
        factory.attachToken(a, address(ext), 1e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ChipFactory8.TokenInUse.selector, a));
        factory.attachToken(b, address(ext), 1e18);
    }

    function test_soloIlProprietarioAggancia8() public {
        vm.prank(alice);
        (uint256 id, ) = factory.mint(_program(), "MIO", "MIO", "", 0, 0);
        ChipToken ext = new ChipToken("Altrove", "ALT5", 999, 1_000_000e18, address(this), 1_000_000e18, address(this));
        ext.transfer(address(factory), 1e18);

        vm.prank(bob);
        vm.expectRevert(ChipFactory8.NotChipOwner.selector);
        factory.attachToken(id, address(ext), 1e18);
    }

    // ---- i numeri che decidono l'economia ------------------------------------

    function test_gasConioETick() public {
        vm.prank(alice);
        uint256 g0 = gasleft();
        (uint256 id, ) = factory.mint(_program(), "GAS CHIP", "GAS", "", LIQ_BPS, TARGET);
        uint256 gasMint = g0 - gasleft();

        factory.tick(id, 0xA5); // primo: slot freddi
        vm.roll(block.number + 1);

        uint256 g1 = gasleft();
        factory.tick(id, 0xA5);
        uint256 gasTick = g1 - gasleft();

        console.log("gas per coniare un chip a 8 bit: ", gasMint);
        console.log("gas per ciclo (esecuzione):      ", gasTick);
        console.log("gas per ciclo (con base tx):     ", gasTick + 21000);
    }
}
