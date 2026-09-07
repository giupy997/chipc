// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INPM} from "../ChipFeeVault.sol";
import {ISwapRouter02, IPoolManager, PoolKey, SwapParams, IWETH9, IOwned} from "../ChipBuybackVault.sol";

/**
 * @title CurveFeeVault — le fee dei lanci a curva
 *
 * Il gemello del ChipBuybackVault per i token della curva, che non hanno una
 * riserva di mining. Riceve due cose:
 *   - le fee dell'1% durante la curva (deposit, solo dalla curva), in quota;
 *   - la posizione LP alla graduazione, che entra e non esce mai (collect di tutti).
 * Ripartizione, decisa al lancio e registrata qui dalla curva:
 *   - creatorBps della quota (e del token, dopo la graduazione) matura al
 *     creator, che la ritira con claim();
 *   - il resto della quota diventa ETH e compra RH4 per la fabbrica (executor,
 *     minOut da fuori: come nei vault dei chip);
 *   - il resto del token viene bruciato: niente riserva a cui darlo.
 * Nessun owner, nessun prelievo. L'executor lo nomina l'owner della fabbrica.
 */
contract CurveFeeVault {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;

    INPM public immutable npm;
    address public immutable factory;        // ChipFactory8: qui atterra l'RH4 ricomprato, e il suo owner nomina l'executor
    address public immutable rh4;
    address public immutable weth;
    ISwapRouter02 public immutable router;
    IPoolManager public immutable poolManager;
    address public immutable hook;
    address public immutable curve;          // l'unico che puo' registrare token e depositare fee

    address public executor;
    struct Reg { address creator; uint16 creatorBps; }
    mapping(address => Reg) public registry;                          // token della curva -> chi e quanto
    mapping(address => mapping(address => uint256)) public claimable; // creator -> token -> maturato
    mapping(address => uint256) public pending;                       // quota in attesa di conversione

    event Registered(address indexed token, address indexed creator, uint16 creatorBps);
    event Deposited(address indexed token, address indexed quote, uint256 amount);
    event FeesSplit(uint256 indexed tokenId, address indexed token, uint256 amount0, uint256 amount1);
    event Accrued(address indexed creator, address indexed token, uint256 amount);
    event Claimed(address indexed creator, address indexed token, uint256 amount);
    event QuotePending(address indexed token, uint256 amount, uint256 total);
    event Burned(address indexed token, uint256 amount);
    event Converted(address indexed token, uint256 amountIn, uint256 ethOut);
    event Buyback(uint256 ethIn, uint256 rh4Out, address indexed by);
    event ExecutorSet(address indexed executor);

    error NotCurve();
    error NotExecutor();
    error NotFactoryOwner();
    error NotPoolManager();
    error NothingToDo();
    error TooMuch();
    error TooLittleOut(uint256 got, uint256 min);

    constructor(
        INPM npm_, address factory_, address rh4_, address weth_,
        ISwapRouter02 router_, IPoolManager poolManager_, address hook_,
        address curve_, address executor_
    ) {
        npm = npm_; factory = factory_; rh4 = rh4_; weth = weth_;
        router = router_; poolManager = poolManager_; hook = hook_;
        curve = curve_; executor = executor_;
        emit ExecutorSet(executor_);
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ---- della curva -------------------------------------------------------

    function register(address token, address creator, uint16 creatorBps) external {
        if (msg.sender != curve) revert NotCurve();
        registry[token] = Reg({ creator: creator, creatorBps: creatorBps });
        emit Registered(token, creator, creatorBps);
    }

    /// @notice Le fee della fase a curva: la curva ha gia' approvato `amount` di `quote`.
    function deposit(address token, address quote, uint256 amount) external {
        if (msg.sender != curve) revert NotCurve();
        if (amount == 0) revert NothingToDo();
        IERC20(quote).safeTransferFrom(msg.sender, address(this), amount);
        _route(token, quote, amount);
        emit Deposited(token, quote, amount);
    }

    // ---- di tutti ----------------------------------------------------------

    /// @notice Riscuote le fee di una posizione LP di un lancio graduato.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        (, , address token0, address token1, , , , , , , , ) = npm.positions(tokenId);
        address token = registry[token0].creator != address(0) || registry[token0].creatorBps != 0 ? token0
            : (registry[token1].creator != address(0) || registry[token1].creatorBps != 0 ? token1 : address(0));
        (amount0, amount1) = npm.collect(INPM.CollectParams({
            tokenId: tokenId, recipient: address(this),
            amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));
        _route(token, token0, amount0);
        _route(token, token1, amount1);
        emit FeesSplit(tokenId, token, amount0, amount1);
    }

    function claim(address token) public returns (uint256 amount) {
        amount = claimable[msg.sender][token];
        if (amount == 0) revert NothingToDo();
        claimable[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, token, amount);
    }

    function claimMany(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) claim(tokens[i]);
    }

    // ---- dell'executor -----------------------------------------------------

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

    function buyback(uint256 amountIn, uint256 minOut) external onlyExecutor {
        if (amountIn == 0) revert NothingToDo();
        if (amountIn > address(this).balance) revert TooMuch();
        bytes memory res = poolManager.unlock(abi.encode(amountIn, minOut));
        emit Buyback(amountIn, abi.decode(res, (uint256)), msg.sender);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 amountIn, uint256 minOut) = abi.decode(data, (uint256, uint256));
        int256 delta = poolManager.swap(
            PoolKey({ currency0: address(0), currency1: rh4, fee: 0, tickSpacing: 200, hooks: hook }),
            SwapParams({ zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: uint160(MIN_SQRT_PRICE_PLUS_ONE) }),
            ""
        );
        int128 owed = int128(delta >> 128);
        int128 got = int128(delta);
        uint256 out = uint256(uint128(got));
        if (got <= 0 || out < minOut) revert TooLittleOut(out, minOut);
        poolManager.settle{value: uint256(uint128(-owed))}();
        poolManager.take(rh4, factory, out);
        return abi.encode(out);
    }

    function setExecutor(address executor_) external {
        if (msg.sender != IOwned(factory).owner()) revert NotFactoryOwner();
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    modifier onlyExecutor() {
        if (msg.sender != executor && msg.sender != IOwned(factory).owner()) revert NotExecutor();
        _;
    }

    // ---- interno -----------------------------------------------------------

    /// @dev `token` e' il token del lancio (per la registry); `asset` cio' che e' arrivato.
    function _route(address token, address asset, uint256 amount) internal {
        if (amount == 0) return;
        Reg memory r = registry[token];
        if (r.creator != address(0) && r.creatorBps != 0) {
            uint256 share = amount * r.creatorBps / 10_000;
            if (share != 0) { claimable[r.creator][asset] += share; emit Accrued(r.creator, asset, share); }
            amount -= share;
        }
        if (amount == 0) return;
        if (asset == token) {
            IERC20(asset).safeTransfer(DEAD, amount);               // il lato token: al fuoco
            emit Burned(asset, amount);
        } else if (asset == weth) {
            IWETH9(weth).withdraw(amount);                           // pronto per il buyback
        } else {
            pending[asset] += amount;
            emit QuotePending(asset, amount, pending[asset]);
        }
    }
}
