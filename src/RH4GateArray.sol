// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RH4Gates} from "./RH4Gates.sol";
import {RH4State} from "./RH4State.sol";

/**
 * @title RH4GateArray — il silicio, deployato una volta e condiviso da tutti
 *
 * Contiene le 1.029 porte NAND srotolate. E' `pure`: non ha stato, non ha
 * padrone, non puo' essere fermato ne' aggiornato. Ogni chip coniato dalla
 * fabbrica tiene i propri 79 bit e chiama qui dentro per farli avanzare.
 *
 * E' la ragione per cui un chip costa spiccioli: i 18 kB di bytecode dei gate
 * si pagano una volta per tutta la chain, non una volta per processore.
 */
contract RH4GateArray {
    /// @notice Quante porte NAND compongono il processore.
    uint256 public constant GATES = RH4Gates.GATES;
    /// @notice Quanti flip-flop, cioe' quanti bit di stato architetturale.
    uint256 public constant FLOPS = RH4Gates.FLOPS;

    /**
     * @notice Un colpo di clock.
     * @param state i 79 bit dei flip-flop
     * @param instr l'istruzione a 12 bit gia' letta dalla ROM
     * @return i 79 bit dopo il fronte di salita
     */
    function step(uint256 state, uint256 instr) external pure returns (uint256) {
        return RH4Gates.step(state, instr);
    }

    /**
     * @notice Esegue fino a `maxCycles` colpi di clock e restituisce dove si
     *         e' arrivati. Serve ai frontend: una `view` sola invece di N
     *         chiamate, e via `eth_call` non costa niente a nessuno.
     * @dev Si ferma da sola se il processore incontra HLT.
     */
    function run(uint256 state, uint256[16] calldata rom, uint256 maxCycles)
        external
        pure
        returns (uint256 finalState, uint256 executed)
    {
        uint256 s = state;
        unchecked {
            while (executed < maxCycles && !RH4State.halted(s)) {
                uint256 pc = RH4State.pc(s);
                s = RH4Gates.step(s, (rom[pc >> 4] >> ((pc & 15) * 16)) & 0xfff);
                ++executed;
            }
        }
        finalState = s;
    }
}
