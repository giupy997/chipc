// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {INPM} from "./ChipFeeVault.sol";
import {IChipFactoryLite} from "./ChipCreatorVault.sol";
import {ISwapRouter02, IPoolManager, PoolKey, SwapParams, IWETH9, IOwned} from "./ChipBuybackVault.sol";

/**
 * @title ChipHoldersVault — le fee che tornano a chi tiene il token
 *
 * Quarta casa per la posizione LP di un chip, con la stessa regola delle
 * altre: entra e non esce mai. Le fee dell'1% si dividono cosi', in
 * entrambe le monete, ogni volta che qualcuno chiama collect():
 *
 *   - l'80% matura per gli HOLDER del chip token, in un mucchio per chip e
 *     per moneta (undistributed);
 *   - il 20% del chip token va in fabbrica, riserva di mining;
 *   - il 20% della quote (WETH, azioni) diventa ETH e ricompra RH4 per la
 *     madre, come nei vault buyback.
 *
 * Il mucchio degli holder si distribuisce a epoche, per chip: l'executor
 * (il keeper) fotografa gli holder fuori dalla chain, pubblica la radice
 * Merkle e gli importi; chiunque puo' chiamare claim() per un holder, quindi
 * il keeper spinge i pagamenti e nessuno deve connettere il wallet. La
 * foglia e' quella del RH4StockVault: (id, account, balance). Cio' che
 * un'epoca scaduta non ha pagato torna nel mucchio del suo chip.
 *
 * Il gas della consegna lo pagano le fee stesse: quando e' l'executor a
 * chiamare claim() o publish(), il vault gli rimborsa il gas speso dal suo
 * ETH (il 20% della quote), con un tetto per chiamata e solo se ne ha.
 * Il keeper tiene una scorta iniziale e basta; il resto compra RH4.
 *
 * Nessun owner, nessun prelievo. L'executor lo nomina l'owner della
 * fabbrica e puo' solo: pubblicare epoche (con importi presi dal mucchio
 * del chip giusto), chiuderle a scadenza, convertire la quota buyback e
 * comprare RH4 per la fabbrica.
 */
contract ChipHoldersVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant HOLDERS_BPS = 8000;
    uint256 public constant MIN_EPOCH_DURATION = 7 days;
    uint256 public constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint256 public constant MAX_GAS_REFUND = 0.001 ether;   // tetto per chiamata: il gas qui costa ~1e-5 ETH
    uint256 public constant REFUND_OVERHEAD = 35_000;       // il gas della transazione fuori dal corpo (base + calldata + il rimborso stesso)

    INPM public immutable npm;
    IChipFactoryLite public immutable factory;
    address public immutable rh4;
    address public immutable weth;
    ISwapRouter02 public immutable router;
    IPoolManager public immutable poolManager;
    address public immutable hook;

    address public executor;
    /// chip token -> moneta -> quota holder in attesa di un'epoca
    mapping(address => mapping(address => uint256)) public undistributed;
    /// quote in attesa di conversione (lato buyback)
    mapping(address => uint256) public pending;

    struct Epoch {
        address token;          // il chip token di cui si pagano gli holder
        bytes32 root;
        uint256 totalEligible;  // somma dei saldi nell'albero
        uint64 publishedAt;
        uint64 expiresAt;
        address[] assets;
        uint256[] amounts;
        uint256[] claimed;
        bool expired;
    }
    Epoch[] private _epochs;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    event FeesSplit(uint256 indexed tokenId, uint256 indexed chipId, address indexed token, uint256 amount0, uint256 amount1);
    event ForHolders(address indexed token, address indexed asset, uint256 amount, uint256 total);
    event QuotePending(address indexed asset, uint256 amount, uint256 total);
    event EpochPublished(uint256 indexed id, address indexed token, bytes32 root, uint256 totalEligible, address[] assets, uint256[] amounts, uint64 expiresAt);
    event Claimed(uint256 indexed id, address indexed account, uint256 balance, address[] assets, uint256[] amounts);
    event GasRefunded(address indexed executor, uint256 amount);
    event EpochExpired(uint256 indexed id, address[] assets, uint256[] returned);
    event Converted(address indexed asset, uint256 amountIn, uint256 ethOut);
    event Buyback(uint256 ethIn, uint256 rh4Out, address indexed by);
    event ExecutorSet(address indexed executor);

    error NotExecutor();
    error NotFactoryOwner();
    error NotPoolManager();
    error NotAChipPosition();
    error NothingToDo();
    error TooMuch();
    error TooLittleOut(uint256 got, uint256 min);
    error BadEpoch();
    error BadProof();
    error AlreadyClaimed();
    error NotYetExpired();

    constructor(
        INPM npm_, IChipFactoryLite factory_, address rh4_, address weth_,
        ISwapRouter02 router_, IPoolManager poolManager_, address hook_, address executor_
    ) {
        npm = npm_; factory = factory_; rh4 = rh4_; weth = weth_;
        router = router_; poolManager = poolManager_; hook = hook_;
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ---- di tutti ----------------------------------------------------------

    /// @notice Riscuote le fee di una posizione e le divide: 80% agli holder
    ///         del chip, 20% riserva (token) o buyback (quote). Niente swap.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        (, , address token0, address token1, , , , , , , , ) = npm.positions(tokenId);
        uint256 chipId = factory.chipByToken(token0);
        address token = token0;
        if (chipId == 0) { chipId = factory.chipByToken(token1); token = token1; }
        if (chipId == 0) revert NotAChipPosition();

        (amount0, amount1) = npm.collect(INPM.CollectParams({
            tokenId: tokenId, recipient: address(this),
            amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));
        _route(token, token0, amount0);
        _route(token, token1, amount1);
        emit FeesSplit(tokenId, chipId, token, amount0, amount1);
    }

    /// @notice Paga a `account` la sua quota di un'epoca. Lo puo' chiamare
    ///         chiunque: il keeper spinge, l'holder ritira, il risultato e' lo stesso.
    function claim(uint256 id, address account, uint256 balance, bytes32[] calldata proof) public nonReentrant {
        uint256 gasStart = gasleft();
        if (id >= _epochs.length) revert BadEpoch();
        Epoch storage e = _epochs[id];
        if (e.expired) revert BadEpoch();
        if (hasClaimed[id][account]) revert AlreadyClaimed();
        if (balance == 0 || !MerkleProof.verify(proof, e.root, leaf(id, account, balance))) revert BadProof();
        hasClaimed[id][account] = true;

        uint256 n = e.assets.length;
        uint256[] memory out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 amt = e.amounts[i] * balance / e.totalEligible;
            out[i] = amt;
            if (amt == 0) continue;
            e.claimed[i] += amt;
            IERC20(e.assets[i]).safeTransfer(account, amt);
        }
        emit Claimed(id, account, balance, e.assets, out);
        _refundGas(gasStart);
    }

    function claimMany(uint256[] calldata ids, address account, uint256[] calldata balances, bytes32[][] calldata proofs) external {
        if (ids.length != balances.length || ids.length != proofs.length) revert BadEpoch();
        for (uint256 i; i < ids.length; ++i) claim(ids[i], account, balances[i], proofs[i]);
    }

    // ---- dell'executor -----------------------------------------------------

    /// @notice Apre un'epoca per gli holder di `token`, con importi presi dal suo mucchio.
    function publish(address token, bytes32 root, uint256 totalEligible, address[] calldata assets, uint256[] calldata amounts, uint64 duration)
        external onlyExecutor returns (uint256 id)
    {
        uint256 gasStart = gasleft();
        if (root == bytes32(0) || totalEligible == 0 || assets.length == 0 || assets.length != amounts.length) revert BadEpoch();
        if (duration < MIN_EPOCH_DURATION) revert BadEpoch();
        id = _epochs.length;
        Epoch storage e = _epochs.push();
        e.token = token; e.root = root; e.totalEligible = totalEligible;
        e.publishedAt = uint64(block.timestamp); e.expiresAt = uint64(block.timestamp) + duration;
        e.claimed = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            if (amounts[i] == 0 || amounts[i] > undistributed[token][assets[i]]) revert TooMuch();
            undistributed[token][assets[i]] -= amounts[i];
            e.assets.push(assets[i]);
            e.amounts.push(amounts[i]);
        }
        emit EpochPublished(id, token, root, totalEligible, assets, amounts, e.expiresAt);
        _refundGas(gasStart);
    }

    /// @notice Chiude un'epoca scaduta: il non ritirato torna nel mucchio del chip.
    function expire(uint256 id) external onlyExecutor {
        if (id >= _epochs.length) revert BadEpoch();
        Epoch storage e = _epochs[id];
        if (e.expired) revert BadEpoch();
        if (block.timestamp < e.expiresAt) revert NotYetExpired();
        e.expired = true;
        uint256 n = e.assets.length;
        uint256[] memory back = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            back[i] = e.amounts[i] - e.claimed[i];
            undistributed[e.token][e.assets[i]] += back[i];
        }
        emit EpochExpired(id, e.assets, back);
    }

    /// @notice Converte una quote della quota buyback in ETH. Il minimo lo decide chi chiama, fuori dalla chain.
    function convert(address asset, uint256 amountIn, uint256 minOut, uint24 fee) external onlyExecutor {
        if (amountIn == 0) revert NothingToDo();
        if (amountIn > pending[asset]) revert TooMuch();
        pending[asset] -= amountIn;
        IERC20(asset).forceApprove(address(router), amountIn);
        uint256 got = router.exactInputSingle(ISwapRouter02.ExactInputSingleParams({
            tokenIn: asset, tokenOut: weth, fee: fee, recipient: address(this),
            amountIn: amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
        }));
        IWETH9(weth).withdraw(got);
        emit Converted(asset, amountIn, got);
    }

    /// @notice Compra RH4 con l'ETH tenuto qui e lo consegna alla fabbrica.
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
        poolManager.take(rh4, address(factory), out);
        return abi.encode(out);
    }

    function setExecutor(address executor_) external {
        if (msg.sender != IOwned(address(factory)).owner()) revert NotFactoryOwner();
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    modifier onlyExecutor() {
        if (msg.sender != executor && msg.sender != IOwned(address(factory)).owner()) revert NotExecutor();
        _;
    }

    // ---- viste -------------------------------------------------------------

    function epochCount() external view returns (uint256) { return _epochs.length; }

    function epoch(uint256 id) external view returns (
        address token, bytes32 root, uint256 totalEligible, uint64 publishedAt, uint64 expiresAt,
        address[] memory assets, uint256[] memory amounts, uint256[] memory claimed, bool expired
    ) {
        Epoch storage e = _epochs[id];
        return (e.token, e.root, e.totalEligible, e.publishedAt, e.expiresAt, e.assets, e.amounts, e.claimed, e.expired);
    }

    /// @dev La foglia dello StandardMerkleTree di OpenZeppelin per (uint256, address, uint256).
    function leaf(uint256 id, address account, uint256 balance) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id, account, balance))));
    }

    // ---- interno -----------------------------------------------------------

    /// @dev Se chiama l'executor, il gas della chiamata torna a lui dall'ETH del
    ///      vault: le fee pagano la consegna. Con tetto, e solo se c'e' di che.
    function _refundGas(uint256 gasStart) internal {
        if (msg.sender != executor) return;
        uint256 amount = (gasStart - gasleft() + REFUND_OVERHEAD) * tx.gasprice;
        if (amount > MAX_GAS_REFUND) amount = MAX_GAS_REFUND;
        if (amount == 0 || amount > address(this).balance) return;
        (bool ok, ) = executor.call{value: amount}("");
        if (ok) emit GasRefunded(executor, amount);
    }

    /// @dev `token` e' il chip token della posizione; `asset` cio' che e' arrivato.
    function _route(address token, address asset, uint256 amount) internal {
        if (amount == 0) return;
        uint256 share = amount * HOLDERS_BPS / 10_000;
        if (share != 0) {
            undistributed[token][asset] += share;
            emit ForHolders(token, asset, share, undistributed[token][asset]);
        }
        amount -= share;
        if (amount == 0) return;
        if (asset == token) {
            IERC20(asset).safeTransfer(address(factory), amount);   // riserva di mining
        } else if (asset == weth) {
            IWETH9(weth).withdraw(amount);                           // pronto per il buyback
        } else {
            pending[asset] += amount;
            emit QuotePending(asset, amount, pending[asset]);
        }
    }
}
