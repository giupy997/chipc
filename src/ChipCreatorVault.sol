// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INPM} from "./ChipFeeVault.sol";

interface IChipFactoryLite {
    struct Chip {
        uint256 machine;
        bytes32 label;
        bytes32 ticker;
        address minter;
        uint64 bornBlock;
        uint32 resets;
        address token;
        uint96 rewardPerCycle;
    }
    function chipByToken(address token) external view returns (uint256);
    function chip(uint256 id) external view returns (Chip memory);
}

/**
 * @title ChipCreatorVault — la fossa che paga chi ha costruito
 *
 * Terza opzione per la posizione LP di un chip, accanto all'inceneritore e
 * al ChipFeeVault. Stessa garanzia dei fratelli: da qui le posizioni non
 * escono MAI — niente owner, niente transfer, niente decreaseLiquidity.
 *
 * La differenza e' dove vanno le fee dell'1%: meta' al wallet che ha
 * CONIATO il chip — il coniatore originale, scolpito nella struct alla
 * nascita, non chi possiede l'NFT oggi — e meta' alla fabbrica, dove il
 * lato chip-token allunga la riserva di mining.
 *
 * Cosi' un chip che scambia paga per sempre chi l'ha costruito. Il 50/50
 * e' inciso qui sotto, non in un parametro: nessuno puo' cambiarlo.
 */
contract ChipCreatorVault {
    using SafeERC20 for IERC20;

    INPM public immutable npm;
    IChipFactoryLite public immutable factory;

    event FeesSplit(uint256 indexed tokenId, uint256 indexed chipId, address indexed creator, uint256 amount0, uint256 amount1);

    constructor(INPM npm_, IChipFactoryLite factory_) {
        npm = npm_;
        factory = factory_;
    }

    /// @notice Accetta qualsiasi posizione. Ingresso libero, uscita: nessuna.
    function onERC721Received(address, address, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    /// @notice Riscuote le fee della posizione e le divide a meta': coniatore
    ///         e fabbrica. Aperta a chiunque — premere il bottone e' un
    ///         servizio pubblico, non un privilegio.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        (, , address token0, address token1, , , , , , , , ) = npm.positions(tokenId);

        // il chip lo si riconosce dal suo token: uno dei due lati lo e'
        uint256 chipId = factory.chipByToken(token0);
        if (chipId == 0) chipId = factory.chipByToken(token1);

        (amount0, amount1) = npm.collect(INPM.CollectParams({
            tokenId: tokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        }));

        // nessun chip riconosciuto: tutto alla fabbrica, come il fratello
        address creator = chipId != 0 ? factory.chip(chipId).minter : address(0);

        _split(token0, creator);
        _split(token1, creator);
        emit FeesSplit(tokenId, chipId, creator, amount0, amount1);
    }

    /// @dev Meta' al coniatore, il resto (meta' + eventuali arrotondamenti)
    ///      alla fabbrica. Senza coniatore, tutto alla fabbrica.
    function _split(address token, address creator) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        if (creator != address(0)) {
            uint256 half = bal / 2;
            if (half != 0) IERC20(token).safeTransfer(creator, half);
            bal -= half;
        }
        IERC20(token).safeTransfer(address(factory), bal);
    }
}
