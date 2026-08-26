// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {RH8GateArray} from "../src/RH8Gates.sol";
import {RH8State} from "../src/RH8State.sol";

/**
 * L'interprete non deve somigliare al processore: deve esserlo.
 *
 * Questo test esegue lo stesso programma del banco Verilog e pretende gli
 * stessi identici numeri, allo stesso ciclo. Se qui esce qualcosa di
 * diverso, e' l'interprete ad aver torto — non il silicio.
 *
 * Il ciclo qui sotto e' anche la specifica di cosa dovra' fare il contratto
 * a ogni blocco, nello stesso ordine:
 *
 *   1. leggi ROM[pc] e RAM[ram_addr]
 *   2. fai girare i gate
 *   3. se il nuovo stato alza ram_we, scrivi in RAM
 */
contract RH8Test is Test {
    RH8GateArray internal gates;

    uint256[16] internal rom;
    mapping(uint256 => uint8) internal ram;

    function setUp() public {
        gates = new RH8GateArray();

        // [24:20] op  [19:16] rd  [15:12] rs  [11:0] imm/addr
        rom[0]  = 0x1500000; // IN   r0
        rom[1]  = 0x0110020; // LDI  r1, #0x20
        rom[2]  = 0x1410000; // ST   [r1], r0
        rom[3]  = 0x0100000; // LDI  r0, #0
        rom[4]  = 0x1321000; // LD   r2, [r1]
        rom[5]  = 0x0000000; // NOP        la load si chiude qui
        rom[6]  = 0x1620000; // OUT  r2
        rom[7]  = 0x01300C8; // LDI  r3, #200
        rom[8]  = 0x0140064; // LDI  r4, #100
        rom[9]  = 0x0334000; // ADD  r3, r4
        rom[10] = 0x1630000; // OUT  r3
        rom[11] = 0x1A0000D; // JC   13
        rom[12] = 0x1C00000; // HLT
        rom[13] = 0x01500FF; // LDI  r5, #255
        rom[14] = 0x1650000; // OUT  r5
        rom[15] = 0x1C00000; // HLT
    }

    /// Un colpo di clock, esattamente come lo fara' il contratto.
    function _tick(uint256 state, uint8 inPort) internal returns (uint256 next) {
        uint256 pc = RH8State.pc(state);
        uint256 instr = pc < 16 ? rom[pc] : 0;
        uint8 ramData = ram[RH8State.ramAddr(state)];

        next = gates.step(state, instr, inPort, ramData);

        if (RH8State.ramWe(next)) {
            ram[RH8State.ramAddr(next)] = RH8State.ramWdata(next);
        }
    }

    /// Gli stessi tre numeri del banco Verilog, agli stessi cicli.
    function test_stessiNumeriDelSilicio() public {
        uint8[3] memory expected = [uint8(165), 44, 255];
        uint256 seen;
        uint256 state;
        uint256 cycles;

        while (cycles < 200 && !RH8State.halted(state)) {
            uint256 pc = RH8State.pc(state);
            bool isOut = pc < 16 && (rom[pc] >> 20) == 22;

            state = _tick(state, 0xA5);
            ++cycles;

            if (isOut) {
                assertLt(seen, 3, "piu' uscite del previsto");
                assertEq(RH8State.out(state), expected[seen], "uscita diversa dal silicio");
                ++seen;
            }
        }

        assertTrue(RH8State.halted(state), "il processore non si e' fermato");
        assertEq(seen, 3, "uscite mancanti");
        assertEq(cycles, 15, "conteggio cicli diverso dall'RTL");
        assertEq(RH8State.pc(state), 15, "fermo nel posto sbagliato: carry mancato?");
        assertEq(ram[0x20], 165, "il byte non e' arrivato in RAM");
    }

    /// La cosa che la RH-4 non poteva fare: ricevere qualcosa da fuori.
    /// Stesso programma, ingressi diversi, uscite diverse.
    function test_lIngressoCambiaIlRisultato() public {
        uint8[3] memory inputs = [uint8(1), 200, 255];
        for (uint256 i; i < 3; ++i) {
            uint256 state;
            for (uint256 c; c < 8; ++c) state = _tick(state, inputs[i]);
            // dopo otto cicli la OUT del byte letto e' gia' avvenuta
            assertEq(RH8State.out(state), inputs[i], "l'uscita non segue l'ingresso");
            assertEq(ram[0x20], inputs[i], "la RAM non ha ricevuto il byte");
        }
    }

    /// Il numero che decide l'economia del clock.
    function test_gasPerCiclo() public {
        uint256 state = _tick(0, 0xA5); // primo giro: slot freddi
        uint256 before = gasleft();
        state = _tick(state, 0xA5);
        uint256 spesi = before - gasleft();

        console.log("gas per ciclo (interprete, esecuzione):", spesi);
        console.log("gas per ciclo (con i 21k di base tx):  ", spesi + 21000);
        console.log("RH-4 srotolata, per confronto:          61389");
    }
}
