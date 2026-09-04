// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INPM} from "./ChipFeeVault.sol";
import {IChipFactoryLite} from "./ChipCreatorVault.sol";

interface IWETH9 {
    function withdraw(uint256) external;
}

/// SwapRouter02: exactInputSingle senza deadline.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

interface IV3Pool {
    function slot0() external view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool);
}

interface IV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

/// Il minimo indispensabile di Uniswap v4: Currency e IHooks sono address.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

/**
 * @title ChipBuybackVault — le fee che ricomprano la madre
 *
 * Stessa custodia senza uscita dei fratelli: le posizioni LP entrano e non
 * escono mai. Cambia solo dove vanno le fee dell'1%:
 *
 *   - una quota (creatorBps) matura qui a nome del coniatore originale, in
 *     entrambe le monete, e la ritira lui con claim() quando vuole;
 *   - il resto del token del chip alla fabbrica: riserva di mining;
 *   - il resto della quote (WETH, NVDA, qualunque azione tokenizzata che
 *     abbia un pool con WETH) NON viene sepolto: diventa ETH e, nella stessa
 *     transazione, compra RH4 sul pool v4 dove la madre e' graduata. L'RH4
 *     finisce nella fabbrica: riserva del chip madre.
 *
 * La strada verso l'ETH il vault se la trova da solo: per ogni quote cerca
 * il pool piu' profondo con WETH sulla V3 factory. Se un pool non esiste
 * ancora, il token resta qui — mai sepolto — e chiunque puo' convertirlo
 * dopo con convert(), quando il pool arriva.
 *
 * Il buyback e' automatico dentro collect(). Il prezzo minimo lo detta lo
 * spot letto on-chain dal PoolManager (tolleranza fissa): un sandwich non
 * puo' mordere piu' di quello. Se il mercato non regge il minimo, l'ETH
 * resta qui — mai perso — e chiunque puo' ritentare con buyback(), anche a
 * fette. Nessun owner, nessun prelievo: da questo contratto escono solo
 * le fee maturate verso il loro coniatore e RH4 verso la fabbrica.
 */
contract ChipBuybackVault {
    using SafeERC20 for IERC20;

    INPM public immutable npm;
    IChipFactoryLite public immutable factory;
    address public immutable rh4;
    address public immutable weth;
    IV3Factory public immutable v3Factory;   // dove cercare il pool quote/WETH
    ISwapRouter02 public immutable router;   // SwapRouter02 per la gamba quote -> WETH
    IPoolManager public immutable poolManager;
    address public immutable hook;           // V2MemeHook di pons sul pool RH4
    uint256 public immutable creatorBps;     // 5000 = meta' al coniatore, 0 = tutto in riserva
    uint256 public constant TOLERANCE_BPS = 500;      // 5% sotto lo spot, hook compreso
    uint256 public constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint256 private constant POOLS_SLOT = 6;

    /// coniatore -> token -> fee maturate e non ancora ritirate
    mapping(address => mapping(address => uint256)) public claimable;
    /// token -> somma di tutto cio' che e' in attesa di claim (non e' nostro)
    mapping(address => uint256) public held;

    event FeesSplit(uint256 indexed tokenId, uint256 indexed chipId, address indexed creator, uint256 amount0, uint256 amount1);
    event Buyback(uint256 ethIn, uint256 rh4Out, address indexed by);
    event BuybackDeferred(uint256 ethHeld);

    event QuoteHeld(address indexed token, uint256 amount);
    event Accrued(address indexed creator, address indexed token, uint256 amount);
    event Claimed(address indexed creator, address indexed token, uint256 amount);

    error NotPoolManager();
    error NothingToBuy();
    error TooLittleOut(uint256 got, uint256 min);
    error NotAQuote();
    error NoRoute();

    constructor(
        INPM npm_, IChipFactoryLite factory_, address rh4_, address weth_,
        IV3Factory v3Factory_, ISwapRouter02 router_, IPoolManager poolManager_, address hook_,
        uint256 creatorBps_
    ) {
        require(creatorBps_ <= 5000, "creator share too big");
        npm = npm_; factory = factory_; rh4 = rh4_; weth = weth_;
        v3Factory = v3Factory_; router = router_; poolManager = poolManager_; hook = hook_;
        creatorBps = creatorBps_;
    }

    receive() external payable {}

    /// @notice Accetta qualsiasi posizione. Ingresso libero, uscita: nessuna.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @notice Riscuote le fee, paga il coniatore, allunga la riserva del chip,
    ///         e con la quote ricompra RH4 per la madre. Aperta a chiunque.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        (, , address token0, address token1, , , , , , , , ) = npm.positions(tokenId);
        uint256 chipId = factory.chipByToken(token0);
        if (chipId == 0) chipId = factory.chipByToken(token1);
        address creator = chipId != 0 ? factory.chip(chipId).minter : address(0);

        (amount0, amount1) = npm.collect(INPM.CollectParams({
            tokenId: tokenId, recipient: address(this),
            amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));

        _route(token0, creator);
        _route(token1, creator);
        emit FeesSplit(tokenId, chipId, creator, amount0, amount1);

        // il buyback nella stessa transazione; se lo spot non regge, l'ETH aspetta
        if (address(this).balance > 0) {
            try this.buyback(address(this).balance) {} catch {
                emit BuybackDeferred(address(this).balance);
            }
        }
    }

    /// @notice Compra RH4 con l'ETH tenuto qui, fino a `amountIn`, e lo manda
    ///         alla fabbrica. Chiunque puo' chiamarla: il minimo lo fissa lo spot.
    function buyback(uint256 amountIn) external {
        if (amountIn > address(this).balance) amountIn = address(this).balance;
        if (amountIn == 0) revert NothingToBuy();
        uint256 minOut = _spotRh4Out(amountIn) * (10_000 - TOLERANCE_BPS) / 10_000;
        bytes memory res = poolManager.unlock(abi.encode(amountIn, minOut));
        uint256 out = abi.decode(res, (uint256));
        emit Buyback(amountIn, out, msg.sender);
    }

    /// @dev Il PoolManager ci richiama qui dentro unlock(): swap, saldo, ritiro.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 amountIn, uint256 minOut) = abi.decode(data, (uint256, uint256));

        int256 delta = poolManager.swap(
            _key(),
            SwapParams({ zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: uint160(MIN_SQRT_PRICE_PLUS_ONE) }),
            ""
        );
        int128 owed = int128(delta >> 128);   // currency0 (ETH): negativo, lo dobbiamo
        int128 got = int128(delta);           // currency1 (RH4): positivo, lo prendiamo
        uint256 out = uint256(uint128(got));
        if (got <= 0 || out < minOut) revert TooLittleOut(out, minOut);

        poolManager.settle{value: uint256(uint128(-owed))}();
        poolManager.take(rh4, address(factory), out);
        return abi.encode(out);
    }

    // ---- interno -----------------------------------------------------------

    /// @dev Quota al coniatore; il resto: token del chip -> fabbrica, quote -> ETH.
    function _route(address token, address creator) internal {
        uint256 bal = _free(token);
        if (bal == 0) return;
        if (creator != address(0) && creatorBps != 0) {
            uint256 share = bal * creatorBps / 10_000;
            if (share != 0) {
                claimable[creator][token] += share;
                held[token] += share;
                emit Accrued(creator, token, share);
            }
            bal -= share;
        }
        if (bal == 0) return;
        if (factory.chipByToken(token) != 0) {
            IERC20(token).safeTransfer(address(factory), bal);   // token del chip: riserva
        } else if (token == weth) {
            IWETH9(weth).withdraw(bal);
        } else {
            // quote: la strada verso l'ETH si cerca; se manca, il token aspetta qui
            try this.convert(token) {} catch { emit QuoteHeld(token, bal); }
        }
    }

    /// @notice Converte in ETH una quote tenuta qui (NVDA, un'azione tokenizzata
    ///         futura...) passando dal pool piu' profondo con WETH. Aperta a
    ///         chiunque: il minimo lo fissa lo spot di quel pool.
    function convert(address token) external {
        if (token == weth || token == rh4 || factory.chipByToken(token) != 0) revert NotAQuote();
        uint256 amount = _free(token);
        if (amount == 0) revert NothingToBuy();
        (address pool, uint24 fee) = _deepestPool(token);
        if (pool == address(0)) revert NoRoute();

        (uint160 sqrtP, , , , , , ) = IV3Pool(pool).slot0();
        uint256 wethOut = token < weth
            ? Math.mulDiv(Math.mulDiv(amount, sqrtP, 1 << 96), sqrtP, 1 << 96)   // token0 -> token1
            : Math.mulDiv(Math.mulDiv(amount, 1 << 96, sqrtP), 1 << 96, sqrtP);  // token1 -> token0
        uint256 minOut = wethOut * (10_000 - TOLERANCE_BPS) / 10_000;

        IERC20(token).forceApprove(address(router), amount);
        uint256 got = router.exactInputSingle(ISwapRouter02.ExactInputSingleParams({
            tokenIn: token, tokenOut: weth, fee: fee, recipient: address(this),
            amountIn: amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
        }));
        IWETH9(weth).withdraw(got);
    }

    /// @notice Il coniatore ritira le sue fee maturate, un token alla volta.
    function claim(address token) public returns (uint256 amount) {
        amount = claimable[msg.sender][token];
        if (amount == 0) revert NothingToBuy();
        claimable[msg.sender][token] = 0;
        held[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, token, amount);
    }

    /// @notice Piu' token in una firma sola.
    function claimMany(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) claim(tokens[i]);
    }

    /// @dev Quanto di un token e' davvero disponibile: il saldo meno cio' che
    ///      aspetta il suo coniatore.
    function _free(address token) internal view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 h = held[token];
        return bal > h ? bal - h : 0;
    }

    /// @dev Fra i pool token/WETH ai fee standard, quello con piu' WETH dentro.
    function _deepestPool(address token) internal view returns (address best, uint24 bestFee) {
        uint24[3] memory fees = [uint24(500), uint24(3000), uint24(10000)];
        uint256 bestDepth;
        for (uint256 i; i < 3; ++i) {
            address pool = v3Factory.getPool(token, weth, fees[i]);
            if (pool == address(0)) continue;
            uint256 depth = IERC20(weth).balanceOf(pool);
            if (depth > bestDepth) { bestDepth = depth; best = pool; bestFee = fees[i]; }
        }
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({ currency0: address(0), currency1: rh4, fee: 0, tickSpacing: 200, hooks: hook });
    }

    /// @dev RH4 per amountIn ETH allo spot: sqrtP^2 / 2^192, letto dal PoolManager.
    function _spotRh4Out(uint256 amountIn) internal view returns (uint256) {
        bytes32 poolId = keccak256(abi.encode(_key()));
        bytes32 slot = keccak256(abi.encodePacked(poolId, POOLS_SLOT));
        uint256 sqrtP = uint256(poolManager.extsload(slot)) & ((1 << 160) - 1);
        return Math.mulDiv(Math.mulDiv(amountIn, sqrtP, 1 << 96), sqrtP, 1 << 96);
    }
}
