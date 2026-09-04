// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INPM} from "./ChipFeeVault.sol";
import {IChipFactoryLite} from "./ChipCreatorVault.sol";

interface IWETH9 {
    function withdraw(uint256) external;
}

interface IOwned {
    function owner() external view returns (address);
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
 *   - il resto della quote (WETH, NVDA, qualunque azione tokenizzata) NON
 *     viene sepolto: aspetta in un secchio, diventa ETH e compra RH4 sul
 *     pool v4 dove la madre e' graduata. L'RH4 finisce nella fabbrica:
 *     riserva del chip madre.
 *
 * Chi puo' fare cosa. collect() e claim() sono di tutti. Gli swap — convert()
 * e buyback() — li fa solo l'executor (il keeper, nominato dall'owner della
 * fabbrica) e con un minOut deciso fuori dalla chain: un prezzo fissato
 * prima della transazione non si manipola dentro la transazione, mentre uno
 * spot letto nello stesso blocco si'. L'executor non puo' rubare: l'unica
 * destinazione degli swap e' RH4 nella fabbrica. Nessun owner, nessun
 * prelievo: da qui escono solo le fee maturate verso il loro coniatore, il
 * token del chip verso la riserva e RH4 verso la fabbrica.
 */
contract ChipBuybackVault {
    using SafeERC20 for IERC20;

    INPM public immutable npm;
    IChipFactoryLite public immutable factory;
    address public immutable rh4;
    address public immutable weth;
    ISwapRouter02 public immutable router;   // SwapRouter02 per la gamba quote -> WETH
    IPoolManager public immutable poolManager;
    address public immutable hook;           // V2MemeHook di pons sul pool RH4
    uint256 public immutable creatorBps;     // 5000 = meta' al coniatore, 0 = tutto in riserva
    uint256 public constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;

    /// chi preme i bottoni degli swap: il keeper, nominato dall'owner della fabbrica
    address public executor;
    /// coniatore -> token -> fee maturate e non ancora ritirate
    mapping(address => mapping(address => uint256)) public claimable;
    /// quote in attesa di conversione (mai contiene cio' che aspetta un coniatore)
    mapping(address => uint256) public pending;

    event FeesSplit(uint256 indexed tokenId, uint256 indexed chipId, address indexed creator, uint256 amount0, uint256 amount1);
    event Accrued(address indexed creator, address indexed token, uint256 amount);
    event Claimed(address indexed creator, address indexed token, uint256 amount);
    event QuotePending(address indexed token, uint256 amount, uint256 total);
    event Converted(address indexed token, uint256 amountIn, uint256 ethOut);
    event Buyback(uint256 ethIn, uint256 rh4Out, address indexed by);
    event ExecutorSet(address indexed executor);

    error NotExecutor();
    error NotFactoryOwner();
    error NotPoolManager();
    error NothingToDo();
    error TooMuch();
    error TooLittleOut(uint256 got, uint256 min);

    constructor(
        INPM npm_, IChipFactoryLite factory_, address rh4_, address weth_,
        ISwapRouter02 router_, IPoolManager poolManager_, address hook_,
        address executor_, uint256 creatorBps_
    ) {
        require(creatorBps_ <= 5000, "creator share too big");
        npm = npm_; factory = factory_; rh4 = rh4_; weth = weth_;
        router = router_; poolManager = poolManager_; hook = hook_;
        executor = executor_;
        creatorBps = creatorBps_;
        emit ExecutorSet(executor_);
    }

    receive() external payable {}

    /// @notice Accetta qualsiasi posizione. Ingresso libero, uscita: nessuna.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ---- di tutti ----------------------------------------------------------

    /// @notice Riscuote le fee di una posizione: la quota del coniatore matura,
    ///         il token del chip va in riserva, la quote aspetta la conversione.
    ///         Aperta a chiunque; non fa swap, quindi non c'e' nulla da manipolare.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        (, , address token0, address token1, , , , , , , , ) = npm.positions(tokenId);
        uint256 chipId = factory.chipByToken(token0);
        if (chipId == 0) chipId = factory.chipByToken(token1);
        address creator = chipId != 0 ? factory.chip(chipId).minter : address(0);

        (amount0, amount1) = npm.collect(INPM.CollectParams({
            tokenId: tokenId, recipient: address(this),
            amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));

        // si ripartisce cio' che e' arrivato ORA, mai il saldo del contratto
        _route(token0, amount0, creator);
        _route(token1, amount1, creator);
        emit FeesSplit(tokenId, chipId, creator, amount0, amount1);
    }

    /// @notice Il coniatore ritira le sue fee maturate, un token alla volta.
    function claim(address token) public returns (uint256 amount) {
        amount = claimable[msg.sender][token];
        if (amount == 0) revert NothingToDo();
        claimable[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, token, amount);
    }

    /// @notice Piu' token in una firma sola.
    function claimMany(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) claim(tokens[i]);
    }

    // ---- dell'executor -----------------------------------------------------

    /// @notice Converte una quote in attesa in ETH sul pool quote/WETH scelto.
    ///         Il minimo lo decide chi chiama, fuori dalla chain.
    function convert(address token, uint256 amountIn, uint256 minOut, uint24 fee) external onlyExecutor {
        if (amountIn == 0) revert NothingToDo();
        if (amountIn > pending[token]) revert TooMuch();
        pending[token] -= amountIn;
        IERC20(token).forceApprove(address(router), amountIn);
        uint256 got = router.exactInputSingle(ISwapRouter02.ExactInputSingleParams({
            tokenIn: token, tokenOut: weth, fee: fee, recipient: address(this),
            amountIn: amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
        }));
        IWETH9(weth).withdraw(got);
        emit Converted(token, amountIn, got);
    }

    /// @notice Compra RH4 con l'ETH tenuto qui e lo consegna alla fabbrica.
    function buyback(uint256 amountIn, uint256 minOut) external onlyExecutor {
        if (amountIn == 0) revert NothingToDo();
        if (amountIn > address(this).balance) revert TooMuch();
        bytes memory res = poolManager.unlock(abi.encode(amountIn, minOut));
        uint256 out = abi.decode(res, (uint256));
        emit Buyback(amountIn, out, msg.sender);
    }

    /// @dev Il PoolManager ci richiama qui dentro unlock(): swap, saldo, ritiro.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 amountIn, uint256 minOut) = abi.decode(data, (uint256, uint256));

        int256 delta = poolManager.swap(
            PoolKey({ currency0: address(0), currency1: rh4, fee: 0, tickSpacing: 200, hooks: hook }),
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

    /// @notice L'owner della fabbrica nomina chi preme i bottoni degli swap.
    function setExecutor(address executor_) external {
        if (msg.sender != IOwned(address(factory)).owner()) revert NotFactoryOwner();
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    modifier onlyExecutor() {
        if (msg.sender != executor && msg.sender != IOwned(address(factory)).owner()) revert NotExecutor();
        _;
    }

    // ---- interno -----------------------------------------------------------

    /// @dev Quota al coniatore; il resto: token del chip -> fabbrica, WETH -> ETH,
    ///      altra quote -> in attesa.
    function _route(address token, uint256 amount, address creator) internal {
        if (amount == 0) return;
        if (creator != address(0) && creatorBps != 0) {
            uint256 share = amount * creatorBps / 10_000;
            if (share != 0) {
                claimable[creator][token] += share;
                emit Accrued(creator, token, share);
            }
            amount -= share;
        }
        if (amount == 0) return;
        if (factory.chipByToken(token) != 0) {
            IERC20(token).safeTransfer(address(factory), amount);   // token del chip: riserva
        } else if (token == weth) {
            IWETH9(weth).withdraw(amount);                           // gia' pronto per il buyback
        } else {
            pending[token] += amount;
            emit QuotePending(token, amount, pending[token]);
        }
    }
}
