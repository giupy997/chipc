// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ICurveStatus {
    function transferBlocked(address token, address to) external view returns (bool);
}

/**
 * @title CurveToken — il token di un lancio a curva
 *
 * Supply fissa, tutta coniata alla curva. Trasferibile da subito, con una
 * sola eccezione finche' la curva non gradua: non si puo' mandare ai pool
 * Uniswap v3 del token (calcolati in anticipo) ne' al position manager.
 * Senza, chiunque potrebbe aprire un mercato parallelo prima della
 * graduazione e la LP del lancio nascerebbe su un prezzo sbagliato.
 */
contract CurveToken is ERC20 {
    address public immutable curve;

    error LockedUntilGraduation();

    constructor(string memory name_, string memory symbol_, uint256 supply, address curve_) ERC20(name_, symbol_) {
        curve = curve_;
        _mint(curve_, supply);
    }

    /// @dev La curva sa quali indirizzi sono i pool (calcolati con CREATE2) e
    ///      se il lancio e' graduato: prima, verso quei pool non si passa.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from != curve && ICurveStatus(curve).transferBlocked(address(this), to)) revert LockedUntilGraduation();
        super._update(from, to, value);
    }
}
