// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface INPM {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function collect(CollectParams calldata params)
        external payable returns (uint256 amount0, uint256 amount1);
    function positions(uint256 tokenId) external view returns (
        uint96 nonce, address operator, address token0, address token1,
        uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity,
        uint256 a, uint256 b, uint128 c, uint128 d
    );
}

/**
 * @title ChipFeeVault — la fossa delle posizioni, con le fee che tornano a casa
 *
 * L'alternativa all'inceneritore, per chi apre il mercato di un chip: la
 * posizione LP finisce qui invece che a 0xdead. Da qui non esce MAI — questo
 * contratto non ha un proprietario, non sa trasferire NFT e non sa togliere
 * liquidita'. La garanzia per i compratori e' identica al burn.
 *
 * La differenza sono le fee dell'1%: chiunque puo' chiamare `collect(id)` e
 * ogni token raccolto viene inoltrato alla fabbrica. Per il token del chip
 * questo significa UNA cosa precisa: la riserva di mining si allunga — le
 * fee di trading vengono redistribuite un ciclo di clock alla volta, a
 * chiunque tenga vivo il processore. Il token di controparte (WETH, NVDA)
 * resta invece prigioniero della fabbrica, che di token non sa liberarsene:
 * di fatto, bruciato.
 *
 * Niente owner, niente pause, niente parametri: quello che leggi e' tutto
 * quello che potra' mai fare.
 */
contract ChipFeeVault {
    using SafeERC20 for IERC20;

    INPM public immutable npm;
    address public immutable factory;

    event FeesForwarded(uint256 indexed tokenId, address token0, address token1, uint256 amount0, uint256 amount1);

    constructor(INPM npm_, address factory_) {
        npm = npm_;
        factory = factory_;
    }

    /// @notice Accetta qualsiasi posizione. Ingresso libero, uscita: nessuna.
    function onERC721Received(address, address, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    /// @notice Riscuote le fee della posizione `tokenId` e le inoltra tutte
    ///         alla fabbrica. Aperta a chiunque: premere il bottone e' un
    ///         servizio pubblico, non un privilegio.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        (, , address token0, address token1, , , , , , , , ) = npm.positions(tokenId);

        (amount0, amount1) = npm.collect(INPM.CollectParams({
            tokenId: tokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        }));

        _forward(token0);
        _forward(token1);
        emit FeesForwarded(tokenId, token0, token1, amount0, amount1);
    }

    /// @dev Tutto il saldo di `token` va alla fabbrica — dove il token di un
    ///      chip diventa riserva, e tutto il resto resta sepolto.
    function _forward(address token) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal != 0) IERC20(token).safeTransfer(factory, bal);
    }
}
