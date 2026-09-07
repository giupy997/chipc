// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapRouter02, IPoolManager, PoolKey, SwapParams} from "./ChipBuybackVault.sol";

interface IWETH9Deposit {
    function deposit() external payable;
}

/**
 * @title RH4StockVault — le fee che diventano azioni per gli holder
 *
 * Qui arriva ETH, a poco a poco, dal creator wallet della madre. Ogni ETH
 * che entra viene diviso in tre (allocate): una quota al marketing, una al
 * buyback di RH4 (che finisce nella fabbrica, come nei vault dei chip), una
 * agli holder. La quota degli holder si converte in azioni tokenizzate
 * (NVDA, SNDK, ...) e si distribuisce a epoche: il keeper fotografa i saldi
 * RH4 fuori chain, pubblica una radice Merkle con le azioni dell'epoca, e
 * ogni holder ritira la sua parte pro-rata con claim(). Cio' che non viene
 * ritirato entro la scadenza torna nel mucchio dell'epoca successiva.
 *
 * Chi puo' fare cosa.
 *   - owner: cambia gli split (marketing con tetto fisso), la lista delle
 *     azioni, il wallet marketing, l'executor. NON puo' prelevare ETH ne'
 *     azioni: da qui escono solo la quota marketing (in allocate), RH4 verso
 *     la fabbrica (buyback) e azioni verso chi le ritira (claim).
 *   - executor (keeper): allocate, convert, buyback, publish, expire. Gli
 *     swap portano un minOut deciso fuori dalla chain, come nei vault dei chip.
 *   - chiunque: claim per se' o per un altro (le azioni vanno sempre al
 *     titolare della foglia).
 */
contract RH4StockVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable rh4;
    address public immutable weth;
    address public immutable factory;        // dove atterra l'RH4 ricomprato
    ISwapRouter02 public immutable router;   // SwapRouter02: WETH -> azione
    IPoolManager public immutable poolManager;
    address public immutable hook;           // V2MemeHook di pons sul pool RH4
    uint256 public constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint256 public constant MAX_MARKETING_BPS = 2_000;
    uint256 public constant MIN_EPOCH_DURATION = 7 days;

    address public owner;
    address public pendingOwner;
    address public executor;
    address public marketing;

    uint256 public holdersBps;
    uint256 public marketingBps;
    uint256 public buybackBps;

    /// ETH gia' allocato e in attesa del suo swap
    uint256 public ethForStocks;
    uint256 public ethForBuyback;

    struct Stock { bool active; uint24 fee; }   // fee: tier del pool WETH/azione
    address[] public stocks;
    mapping(address => Stock) public stockInfo;
    /// azioni comprate e non ancora messe in un'epoca
    mapping(address => uint256) public undistributed;

    struct Epoch {
        bytes32 root;
        uint256 totalEligible;   // somma dei saldi RH4 nelle foglie
        uint64 publishedAt;
        uint64 expiresAt;
        address[] tokens;
        uint256[] amounts;
        uint256[] claimed;
        bool expired;
    }
    Epoch[] internal _epochs;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    event Funded(address indexed from, uint256 amount);
    event Allocated(uint256 toHolders, uint256 toMarketing, uint256 toBuyback);
    event Converted(address indexed stock, uint256 ethIn, uint256 sharesOut);
    event Buyback(uint256 ethIn, uint256 rh4Out, address indexed by);
    event EpochPublished(uint256 indexed epoch, bytes32 root, uint256 totalEligible, address[] tokens, uint256[] amounts, uint64 expiresAt);
    event Claimed(uint256 indexed epoch, address indexed account, uint256 balance, address[] tokens, uint256[] amounts);
    event EpochExpired(uint256 indexed epoch, address[] tokens, uint256[] returned);
    event SplitsSet(uint256 holdersBps, uint256 marketingBps, uint256 buybackBps);
    event StockSet(address indexed stock, bool active, uint24 fee);
    event MarketingSet(address indexed marketing);
    event ExecutorSet(address indexed executor);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotExecutor();
    error NotPoolManager();
    error NothingToDo();
    error TooMuch();
    error BadSplits();
    error BadStock();
    error BadEpoch();
    error BadProof();
    error AlreadyClaimed();
    error NotYetExpired();
    error TooLittleOut(uint256 got, uint256 min);
    error ZeroAddress();

    constructor(
        address owner_, address executor_, address marketing_,
        address rh4_, address weth_, address factory_,
        ISwapRouter02 router_, IPoolManager poolManager_, address hook_,
        uint256 holdersBps_, uint256 marketingBps_, uint256 buybackBps_
    ) {
        if (owner_ == address(0) || marketing_ == address(0) || rh4_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        owner = owner_; executor = executor_; marketing = marketing_;
        rh4 = rh4_; weth = weth_; factory = factory_;
        router = router_; poolManager = poolManager_; hook = hook_;
        _setSplits(holdersBps_, marketingBps_, buybackBps_);
        emit OwnershipTransferred(address(0), owner_);
        emit ExecutorSet(executor_);
        emit MarketingSet(marketing_);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // ---- viste -------------------------------------------------------------

    function unallocated() public view returns (uint256) {
        return address(this).balance - ethForStocks - ethForBuyback;
    }

    function epochCount() external view returns (uint256) { return _epochs.length; }

    function epoch(uint256 id) external view returns (
        bytes32 root, uint256 totalEligible, uint64 publishedAt, uint64 expiresAt,
        address[] memory tokens, uint256[] memory amounts, uint256[] memory claimed, bool expired
    ) {
        Epoch storage e = _epochs[id];
        return (e.root, e.totalEligible, e.publishedAt, e.expiresAt, e.tokens, e.amounts, e.claimed, e.expired);
    }

    function stockCount() external view returns (uint256) { return stocks.length; }

    /// @notice Quanto spetta a un saldo in un'epoca, token per token.
    function shareOf(uint256 id, uint256 balance) public view returns (uint256[] memory out) {
        Epoch storage e = _epochs[id];
        out = new uint256[](e.tokens.length);
        for (uint256 i; i < e.tokens.length; ++i) out[i] = e.amounts[i] * balance / e.totalEligible;
    }

    /// @notice La foglia dell'albero: (epoca, holder, saldo RH4 allo snapshot), doppio hash.
    function leaf(uint256 id, address account, uint256 balance) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id, account, balance))));
    }

    // ---- di tutti ----------------------------------------------------------

    /// @notice Ritira le azioni di un'epoca per `account`. Chiunque puo' chiamarla,
    ///         le azioni vanno sempre ad `account`.
    function claim(uint256 id, address account, uint256 balance, bytes32[] calldata proof) public nonReentrant {
        if (id >= _epochs.length) revert BadEpoch();
        Epoch storage e = _epochs[id];
        if (e.expired) revert BadEpoch();
        if (hasClaimed[id][account]) revert AlreadyClaimed();
        if (balance == 0 || !MerkleProof.verify(proof, e.root, leaf(id, account, balance))) revert BadProof();
        hasClaimed[id][account] = true;

        uint256 n = e.tokens.length;
        uint256[] memory out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 amt = e.amounts[i] * balance / e.totalEligible;
            out[i] = amt;
            if (amt == 0) continue;
            e.claimed[i] += amt;
            IERC20(e.tokens[i]).safeTransfer(account, amt);
        }
        emit Claimed(id, account, balance, e.tokens, out);
    }

    /// @notice Piu' epoche in una firma sola.
    function claimMany(uint256[] calldata ids, address account, uint256[] calldata balances, bytes32[][] calldata proofs) external {
        if (ids.length != balances.length || ids.length != proofs.length) revert BadEpoch();
        for (uint256 i; i < ids.length; ++i) claim(ids[i], account, balances[i], proofs[i]);
    }

    // ---- dell'executor -----------------------------------------------------

    /// @notice Divide l'ETH arrivato: marketing subito, il resto nei due secchi.
    function allocate() external onlyExecutor {
        uint256 amount = unallocated();
        if (amount == 0) revert NothingToDo();
        uint256 toMarketing = amount * marketingBps / 10_000;
        uint256 toBuyback = amount * buybackBps / 10_000;
        uint256 toHolders = amount - toMarketing - toBuyback;
        ethForStocks += toHolders;
        ethForBuyback += toBuyback;
        if (toMarketing != 0) {
            (bool ok, ) = marketing.call{value: toMarketing}("");
            require(ok, "marketing transfer failed");
        }
        emit Allocated(toHolders, toMarketing, toBuyback);
    }

    /// @notice ETH degli holder -> azione, sul pool WETH/azione del tier registrato.
    ///         Il minimo lo decide chi chiama, fuori dalla chain.
    function convert(address stock, uint256 amountIn, uint256 minOut) external onlyExecutor {
        Stock memory s = stockInfo[stock];
        if (!s.active) revert BadStock();
        if (amountIn == 0) revert NothingToDo();
        if (amountIn > ethForStocks) revert TooMuch();
        ethForStocks -= amountIn;
        IWETH9Deposit(weth).deposit{value: amountIn}();
        IERC20(weth).forceApprove(address(router), amountIn);
        uint256 got = router.exactInputSingle(ISwapRouter02.ExactInputSingleParams({
            tokenIn: weth, tokenOut: stock, fee: s.fee, recipient: address(this),
            amountIn: amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
        }));
        undistributed[stock] += got;
        emit Converted(stock, amountIn, got);
    }

    /// @notice Compra RH4 con l'ETH del secchio buyback e lo consegna alla fabbrica.
    function buyback(uint256 amountIn, uint256 minOut) external onlyExecutor {
        if (amountIn == 0) revert NothingToDo();
        if (amountIn > ethForBuyback) revert TooMuch();
        ethForBuyback -= amountIn;
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
        int128 owed = int128(delta >> 128);
        int128 got = int128(delta);
        uint256 out = uint256(uint128(got));
        if (got <= 0 || out < minOut) revert TooLittleOut(out, minOut);
        poolManager.settle{value: uint256(uint128(-owed))}();
        poolManager.take(rh4, factory, out);
        return abi.encode(out);
    }

    /// @notice Apre un'epoca: la radice dello snapshot e le azioni che distribuisce.
    function publish(bytes32 root, uint256 totalEligible, address[] calldata tokens, uint256[] calldata amounts, uint64 duration)
        external onlyExecutor returns (uint256 id)
    {
        if (root == bytes32(0) || totalEligible == 0 || tokens.length == 0 || tokens.length != amounts.length) revert BadEpoch();
        if (duration < MIN_EPOCH_DURATION) revert BadEpoch();
        id = _epochs.length;
        Epoch storage e = _epochs.push();
        e.root = root; e.totalEligible = totalEligible;
        e.publishedAt = uint64(block.timestamp); e.expiresAt = uint64(block.timestamp) + duration;
        e.claimed = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            if (amounts[i] == 0 || amounts[i] > undistributed[tokens[i]]) revert TooMuch();
            undistributed[tokens[i]] -= amounts[i];
            e.tokens.push(tokens[i]);
            e.amounts.push(amounts[i]);
        }
        emit EpochPublished(id, root, totalEligible, tokens, amounts, e.expiresAt);
    }

    /// @notice Scaduta l'epoca, quel che nessuno ha ritirato torna nel mucchio.
    function expire(uint256 id) external onlyExecutor {
        if (id >= _epochs.length) revert BadEpoch();
        Epoch storage e = _epochs[id];
        if (e.expired) revert BadEpoch();
        if (block.timestamp < e.expiresAt) revert NotYetExpired();
        e.expired = true;
        uint256[] memory back = new uint256[](e.tokens.length);
        for (uint256 i; i < e.tokens.length; ++i) {
            back[i] = e.amounts[i] - e.claimed[i];
            undistributed[e.tokens[i]] += back[i];
        }
        emit EpochExpired(id, e.tokens, back);
    }

    // ---- dell'owner --------------------------------------------------------

    function setSplits(uint256 holdersBps_, uint256 marketingBps_, uint256 buybackBps_) external onlyOwner {
        _setSplits(holdersBps_, marketingBps_, buybackBps_);
    }

    function setStock(address stock, bool active, uint24 fee) external onlyOwner {
        if (stock == address(0) || stock == rh4 || stock == weth) revert BadStock();
        if (!stockInfo[stock].active && !_known(stock)) stocks.push(stock);
        stockInfo[stock] = Stock({ active: active, fee: fee });
        emit StockSet(stock, active, fee);
    }

    function setMarketing(address marketing_) external onlyOwner {
        if (marketing_ == address(0)) revert ZeroAddress();
        marketing = marketing_;
        emit MarketingSet(marketing_);
    }

    function setExecutor(address executor_) external onlyOwner {
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---- interno -----------------------------------------------------------

    function _setSplits(uint256 h, uint256 m, uint256 b) internal {
        if (h + m + b != 10_000 || m > MAX_MARKETING_BPS) revert BadSplits();
        holdersBps = h; marketingBps = m; buybackBps = b;
        emit SplitsSet(h, m, b);
    }

    function _known(address stock) internal view returns (bool) {
        for (uint256 i; i < stocks.length; ++i) if (stocks[i] == stock) return true;
        return false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor && msg.sender != owner) revert NotExecutor();
        _;
    }
}
