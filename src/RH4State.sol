// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ┌───────────────────────────────────────────────────────────────────┐
// │  GENERATO DA tools/codegen.js — NON MODIFICARE A MANO.             │
// │  Posizioni dei bit dentro la parola di stato della RH-4.           │
// └───────────────────────────────────────────────────────────────────┘

library RH4State {
    uint256 internal constant BITS = 79;
    uint256 internal constant MASK = (uint256(1) << 79) - 1;

    /// @notice Program counter corrente.
    function pc(uint256 state) internal pure returns (uint8) {
        return uint8((state >> 67) & 0xff);
    }

    /// @notice Ultimo valore latchato sulla porta di uscita.
    function out(uint256 state) internal pure returns (uint8) {
        return uint8((state >> 75) & 0xf);
    }

    /// @notice Vero se il processore ha incontrato HLT.
    function halted(uint256 state) internal pure returns (bool) {
        return (state >> 65) & 1 == 1;
    }

    /// @dev Base di ciascuno dei 16 registri, otto bit per voce.
    uint256 internal constant REG_BASES = 0x105090d1115191d2125292d3135393d;

    /// @notice Uno dei sedici registri da 4 bit.
    function reg(uint256 state, uint256 i) internal pure returns (uint8) {
        return uint8((state >> ((REG_BASES >> (i * 8)) & 0xff)) & 0xf);
    }

}
