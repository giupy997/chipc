// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ChipToken — il token di un chip
 *
 * Offerta fissa, coniata tutta alla nascita del chip e mai piu' toccata:
 * questo contratto non ha una `mint`, quindi non esiste modo di stamparne
 * altri. Ne' l'operatore, ne' il proprietario del chip, ne' la fabbrica.
 *
 * Alla nascita l'offerta si divide in due:
 *
 *   - una fetta va subito a chi conia, per farci la liquidita';
 *   - tutto il resto resta in mano alla fabbrica e ne esce **un ciclo di
 *     clock alla volta**, verso chi quel ciclo l'ha pagato.
 *
 * Il che vuol dire una cosa sola: l'unico modo di ottenere questi token,
 * oltre a comprarli, e' tenere acceso il processore.
 */
interface IChipOwner {
    function ownerOf(uint256 id) external view returns (address);
}

contract ChipToken is ERC20 {
    /// @notice Il chip a cui questo token appartiene.
    uint256 public immutable chipId;
    /// @notice La fabbrica che custodisce la riserva di emissione.
    address public immutable factory;

    /**
     * @notice Il proprietario del token e' chi possiede l'NFT del chip.
     * @dev Esiste per gli explorer: senza un owner() dimostrabile, la
     *      verifica di proprieta' su Blockscout e simili e' impossibile per
     *      un token deployato da una factory. Non conferisce NESSUN potere
     *      sul token — niente mint, niente pause, niente fee: e' una vista.
     */
    function owner() external view returns (address) {
        return IChipOwner(factory).ownerOf(chipId);
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 chipId_,
        uint256 supply,
        address toFactory,
        uint256 toMinter,
        address minter
    ) ERC20(name_, symbol_) {
        chipId = chipId_;
        factory = toFactory;

        // niente premine nascosto: quello che non va alla liquidita' resta
        // alla fabbrica, e da li' esce solo un ciclo alla volta
        if (toMinter != 0) _mint(minter, toMinter);
        _mint(toFactory, supply - toMinter);
    }
}
