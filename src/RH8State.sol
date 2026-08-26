// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// GENERATO DA tools/codegen8.js — dove stanno i bit dentro lo stato.

library RH8State {
    uint256 internal constant BITS = 171;
    uint256 internal constant MASK = (uint256(1) << 171) - 1;

    /// @notice Program counter, 10 bit.
    function pc(uint256 s) internal pure returns (uint16) {
        return uint16((s >> 136) & 0x3ff);
    }

    /// @notice Porta di uscita.
    function out(uint256 s) internal pure returns (uint8) {
        return uint8((s >> 163) & 0xff);
    }

    /// @notice Indirizzo che il contratto deve leggere.
    function ramAddr(uint256 s) internal pure returns (uint8) {
        return uint8((s >> 154) & 0xff);
    }

    /// @notice Dato da scrivere in RAM.
    function ramWdata(uint256 s) internal pure returns (uint8) {
        return uint8((s >> 146) & 0xff);
    }

    /// @notice Vero se questo ciclo scrive in RAM.
    function ramWe(uint256 s) internal pure returns (bool) {
        return (s >> 134) & 1 == 1;
    }

    /// @notice Vero se il processore ha incontrato HLT.
    function halted(uint256 s) internal pure returns (bool) {
        return (s >> 162) & 1 == 1;
    }

    uint256 internal constant REG_BASES = 0x1091119212931394149515961697179;

    /// @notice Uno dei sedici registri da 8 bit.
    function reg(uint256 s, uint256 i) internal pure returns (uint8) {
        return uint8((s >> ((REG_BASES >> (i * 8)) & 0xff)) & 0xff);
    }

    function carry(uint256 s) internal pure returns (bool) { return (s >> 0) & 1 == 1; }
    function zero(uint256 s) internal pure returns (bool) { return (s >> 135) & 1 == 1; }
}
