// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {RH4} from "../src/RH4.sol";
import {RH4Gates} from "../src/RH4Gates.sol";

/**
 * Il test non verifica il contratto contro se stesso: verifica il silicio.
 * La sequenza attesa e' quella che escono dalla simulazione RTL (iverilog) e
 * dalla simulazione gate-level (tools/netsim.js), ciclo per ciclo. Se qui
 * cambia qualcosa, e' il codegen ad aver sbagliato.
 */
contract RH4Test is Test {
    RH4 internal cpu;

    uint256 internal constant EXPECTED_CYCLES = 49;

    function setUp() public {
        cpu = new RH4(_program("fib"));
        vm.roll(block.number + 1);
    }

    function _program(string memory name) internal view returns (uint256[16] memory slots) {
        string memory raw = vm.readFile(string.concat("build/", name, ".slots.json"));
        uint256[] memory parsed = vm.parseJsonUintArray(raw, ".slots");
        require(parsed.length == 16, "slot di ROM attesi: 16");
        for (uint256 i; i < 16; ++i) slots[i] = parsed[i];
    }

    /// Fibonacci a 4 bit: 1 1 2 3 5 8 13, poi il carry sfora e il processore
    /// si ferma. Stessa sequenza, stessi cicli, dell'RTL.
    function test_fibonacci() public {
        uint8[7] memory expected = [uint8(1), 1, 2, 3, 5, 8, 13];
        uint256 seen;
        uint256 cycles;

        while (cycles < 500) {
            (, , bool halted, , ) = cpu.inspect();
            if (halted) break;

            (uint8 pc, , , , ) = cpu.inspect();
            bool isOut = cpu.romAt(pc) >> 8 == 0xe;

            (, uint8 outValue, ) = cpu.tick();
            vm.roll(block.number + 1);
            ++cycles;

            if (isOut) {
                assertLt(seen, 7, "piu' uscite del previsto");
                assertEq(outValue, expected[seen], "termine di Fibonacci sbagliato");
                ++seen;
            }
        }

        (, , bool ended, uint256 count, ) = cpu.inspect();
        assertTrue(ended, "il processore non si e' fermato");
        assertEq(seen, 7, "uscite mancanti");
        assertEq(cycles, EXPECTED_CYCLES, "conteggio cicli diverso dall'RTL");
        assertEq(count, EXPECTED_CYCLES, "contatore di cicli on-chain diverso");
    }

    /// Un colpo di clock per blocco: e' l'unica regola del clock.
    function test_unTickPerBlocco() public {
        cpu.tick();
        vm.expectRevert(RH4.OneTickPerBlock.selector);
        cpu.tick();

        vm.roll(block.number + 1);
        cpu.tick(); // nuovo blocco, si riparte
    }

    /// Il clock non ha padrone: chiunque puo' pagarlo.
    function test_clockPermissionless() public {
        address estraneo = makeAddr("estraneo");
        vm.prank(estraneo);
        cpu.tick();

        (, , , uint256 count, ) = cpu.inspect();
        assertEq(count, 1);
    }

    /// Dopo HLT il processore non si muove piu'.
    function test_haltEDefinitivo() public {
        _runToHalt();
        vm.roll(block.number + 1);
        vm.expectRevert(RH4.AlreadyHalted.selector);
        cpu.tick();
    }

    /// `preview` deve dire la verita' senza toccare lo stato.
    function test_previewNonMuoveNulla() public {
        (uint8 pc, uint8 out, bool halted, uint256 executed) = cpu.preview(500);
        assertTrue(halted);
        assertEq(executed, EXPECTED_CYCLES);
        assertEq(out, 13);

        (, , , uint256 count, ) = cpu.inspect();
        assertEq(count, 0, "preview ha scritto sullo stato");

        _runToHalt();
        (uint8 realPc, uint8 realOut, , , ) = cpu.inspect();
        assertEq(realPc, pc);
        assertEq(realOut, out);
    }

    /// Solo l'operatore cambia il programma, e il cambio azzera la macchina.
    function test_loadRiportaAZero() public {
        cpu.tick();

        address estraneo = makeAddr("estraneo");
        vm.prank(estraneo);
        vm.expectRevert(RH4.NotOperator.selector);
        cpu.load(_program("fib"));

        cpu.load(_program("fib"));
        (uint8 pc, , bool halted, uint256 count, ) = cpu.inspect();
        assertEq(pc, 0);
        assertEq(count, 0);
        assertFalse(halted);
    }

    /// Il programma di mainnet non deve fermarsi. Mai. Se la RH-4 incontra un
    /// HLT il clock muore e solo l'operatore puo' resuscitarla: questo test e'
    /// l'unica cosa che sta fra il lancio e un processore mattone.
    /// 5.238 cicli sono un periodo intero: scanner, contatore e rumore.
    function test_foreverNonSiFermaMai() public {
        RH4 mainnet = new RH4(_program("forever"));
        (, , bool halted, uint256 executed) = mainnet.preview(5300);
        assertFalse(halted, "il programma di mainnet si e' fermato");
        assertEq(executed, 5300, "preview si e' interrotta prima del previsto");
    }

    /// Quanto costa davvero un ciclo. Il numero che decide l'economia del clock.
    function test_gasPerCiclo() public {
        cpu.tick(); // primo tick: slot freddi, non rappresentativo
        vm.roll(block.number + 1);

        uint256 before = gasleft();
        cpu.tick();
        uint256 spesi = before - gasleft();

        console.log("gas per ciclo (esecuzione, senza i 21k di base tx):", spesi);
        console.log("gas per ciclo (totale stimato in tx):", spesi + 21000);
    }

    function _runToHalt() internal {
        for (uint256 i; i < 500; ++i) {
            (, , bool halted, , ) = cpu.inspect();
            if (halted) return;
            cpu.tick();
            vm.roll(block.number + 1);
        }
        revert("nessun halt");
    }
}
