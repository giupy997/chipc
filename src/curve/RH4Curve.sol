// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CurveToken} from "./CurveToken.sol";

interface IWETHFull {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface INPMCurve {
    struct MintParams {
        address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper;
        uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min;
        address recipient; uint256 deadline;
    }
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool);
    function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IV3PoolMin {
    function slot0() external view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool);
    function initialize(uint160) external;
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}
interface IV3FactoryMin { function getPool(address, address, uint24) external view returns (address); }

interface ICurveFeeVault {
    function register(address token, address creator, uint16 creatorBps) external;
    function deposit(address token, address quote, uint256 amount) external;
}

/**
 * @title RH4Curve — il launchpad a curva
 *
 * Un solo contratto per tutti i lanci. Ogni lancio conia un CurveToken da
 * un miliardo: 800M li vende la curva, 200M aspettano la graduazione.
 * La curva e' un prodotto costante con riserve virtuali, i numeri di
 * pump.fun scalati sulla soglia scelta: quando gli 800M sono venduti,
 * quanto raccolto basta quasi esattamente a mettere i 200M in un pool
 * Uniswap v3 a range pieno allo stesso prezzo. La posizione LP nasce nel
 * CurveFeeVault e non esce mai.
 *
 * Quote: WETH (si paga anche in ETH nudo) o qualsiasi ERC-20 ammessa.
 * Fee: 1% su ogni compra e vendita, in quota, al CurveFeeVault, che le
 * divide secondo il modo scelto al lancio (creatorBps: 5000 o 0).
 * Anti-snipe: nei primi SNIPE_BLOCKS blocchi in ogni blocco escono al massimo
 * MAX_EARLY_BUY token, sommando tutte le compre di quel blocco: spezzare
 * la compra in tante chiamate non aiuta.
 */
contract RH4Curve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;     // venduti dalla curva
    uint256 public constant LP_SUPPLY = SUPPLY - CURVE_SUPPLY; // 200M al pool
    uint256 public constant VIRTUAL_TOKENS = 1_073_000_000e18; // riserva virtuale di token
    uint256 public constant FEE_BPS = 100;                      // 1%
    uint256 public constant SNIPE_BLOCKS = 100;
    uint256 public constant MAX_EARLY_BUY = 20_000_000e18;      // 2% della supply per compra, all'inizio
    uint24 public constant POOL_FEE = 10_000;
    int24 public constant TICK_EDGE = 887_200;
    bytes32 public constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;

    address public immutable weth;
    address public immutable v3Factory;
    address public immutable npm;
    address public immutable owner;      // apre/chiude le quote ammesse e la soglia minima; niente altro
    ICurveFeeVault public feeVault;      // fissato una volta, dopo il deploy del vault (dipendenza circolare)

    struct Launch {
        address token;
        address quote;
        address creator;
        uint16 creatorBps;
        uint64 startBlock;
        bool graduated;
        uint256 threshold;      // quota da raccogliere per graduare (unita' della quota)
        uint256 virtualQuote;   // riserva virtuale iniziale di quota
        uint256 quoteRaised;    // quota reale nella curva (al netto delle fee)
        uint256 tokensSold;
        uint256 lpTokenId;
        address pool;
        address[4] pools;       // i pool v3 possibili (fee 100/500/3000/10000): chiusi fino alla graduazione
    }
    mapping(address => Launch) public launches;   // token -> lancio
    mapping(address => mapping(uint256 => uint256)) public soldInBlock;   // token -> blocco -> venduti (finestra anti-snipe)
    address[] public tokens;
    mapping(address => bool) public quoteAllowed;
    mapping(address => uint256) public minThreshold; // per quota

    event Launched(address indexed token, address indexed creator, address indexed quote, uint256 threshold, uint16 creatorBps, string name, string symbol);
    event Bought(address indexed token, address indexed buyer, uint256 quoteIn, uint256 fee, uint256 tokensOut, uint256 tokensSold, uint256 quoteRaised);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tokensSold, uint256 quoteRaised);
    event Graduated(address indexed token, address indexed pool, uint256 lpTokenId, uint256 tokensToPool, uint256 quoteToPool, uint256 quoteLeftover);
    event QuoteSet(address indexed quote, bool allowed, uint256 minThreshold);
    event FeeVaultSet(address indexed vault);

    error NotOwner();
    error QuoteNotAllowed();
    error ThresholdTooLow();
    error BadCreatorBps();
    error Unknown();
    error AlreadyGraduated();
    error NotGraduated();
    error NothingToDo();
    error TooLittleOut(uint256 got, uint256 min);
    error EarlyBuyTooBig();
    error BadName();
    error NotWETHQuote();
    error VaultAlreadySet();

    constructor(address weth_, address v3Factory_, address npm_, address owner_) {
        weth = weth_; v3Factory = v3Factory_; npm = npm_; owner = owner_;
    }

    receive() external payable { if (msg.sender != weth) revert Unknown(); }   // solo il WETH che si scarta

    // ---- dell'owner: solo la lista delle quote e il vault (una volta) -----------

    function setQuote(address quote, bool allowed, uint256 minThreshold_) external {
        if (msg.sender != owner) revert NotOwner();
        if (allowed && minThreshold_ == 0) revert ThresholdTooLow();   // una soglia zero rende il lancio ingraduabile
        quoteAllowed[quote] = allowed;
        minThreshold[quote] = minThreshold_;
        emit QuoteSet(quote, allowed, minThreshold_);
    }

    function setFeeVault(address vault) external {
        if (msg.sender != owner) revert NotOwner();
        if (address(feeVault) != address(0)) revert VaultAlreadySet();
        feeVault = ICurveFeeVault(vault);
        emit FeeVaultSet(vault);
    }

    // ---- viste -------------------------------------------------------------

    function count() external view returns (uint256) { return tokens.length; }
    function graduated(address token) external view returns (bool) { return launches[token].graduated; }
    function poolsOf(address token) external view returns (address[4] memory) { return launches[token].pools; }

    /// @notice Prima della graduazione il token non entra nei suoi pool ne' nel position manager.
    function transferBlocked(address token, address to) external view returns (bool) {
        Launch storage l = launches[token];
        if (l.token == address(0) || l.graduated) return false;
        if (to == npm) return true;
        for (uint256 i; i < 4; ++i) if (to == l.pools[i]) return true;
        return false;
    }

    /// @notice Prezzo marginale: quota (grezza) per token (grezzo), in 1e18.
    function price(address token) external view returns (uint256) {
        Launch storage l = launches[token];
        return (l.virtualQuote + l.quoteRaised) * 1e18 / (VIRTUAL_TOKENS - l.tokensSold);
    }

    /// @notice Token che escono per `quoteIn` (al lordo della fee), e la fee.
    function quoteBuy(address token, uint256 quoteIn) public view returns (uint256 tokensOut, uint256 fee) {
        Launch storage l = launches[token];
        fee = quoteIn * FEE_BPS / 10_000;
        uint256 dq = quoteIn - fee;
        uint256 vq = l.virtualQuote + l.quoteRaised;
        uint256 vt = VIRTUAL_TOKENS - l.tokensSold;
        tokensOut = vt * dq / (vq + dq);
        uint256 left = CURVE_SUPPLY - l.tokensSold;
        if (tokensOut > left) tokensOut = left;
    }

    /// @notice Quota necessaria (al lordo della fee) per comprare esattamente `tokensOut`.
    function costFor(address token, uint256 tokensOut) public view returns (uint256 quoteIn, uint256 fee) {
        Launch storage l = launches[token];
        uint256 vq = l.virtualQuote + l.quoteRaised;
        uint256 vt = VIRTUAL_TOKENS - l.tokensSold;
        uint256 dq = (vq * tokensOut + (vt - tokensOut) - 1) / (vt - tokensOut);   // arrotonda in su
        quoteIn = (dq * 10_000 + (10_000 - FEE_BPS) - 1) / (10_000 - FEE_BPS);
        fee = quoteIn - dq;
    }

    /// @notice Quota che esce vendendo `tokensIn`, al netto della fee.
    function quoteSell(address token, uint256 tokensIn) public view returns (uint256 quoteOut, uint256 fee) {
        Launch storage l = launches[token];
        uint256 vq = l.virtualQuote + l.quoteRaised;
        uint256 vt = VIRTUAL_TOKENS - l.tokensSold;
        uint256 gross = vq * tokensIn / (vt + tokensIn);
        fee = gross * FEE_BPS / 10_000;
        quoteOut = gross - fee;
    }

    // ---- lanciare ----------------------------------------------------------

    /// @notice Conia il token e apre la curva. creatorBps: 5000 (meta' delle fee al creator) o 0 (tutto in buyback).
    function launch(string calldata name, string calldata symbol, address quote, uint256 threshold, uint16 creatorBps)
        external returns (address token)
    {
        if (!quoteAllowed[quote]) revert QuoteNotAllowed();
        if (threshold < minThreshold[quote] || threshold * 30 / 85 == 0) revert ThresholdTooLow();
        if (creatorBps != 5000 && creatorBps != 0) revert BadCreatorBps();
        if (address(feeVault) == address(0)) revert Unknown();
        if (bytes(name).length == 0 || bytes(name).length > 32 || bytes(symbol).length == 0 || bytes(symbol).length > 12) revert BadName();

        token = address(new CurveToken(name, symbol, SUPPLY, address(this)));

        Launch storage l = launches[token];
        l.token = token; l.quote = quote; l.creator = msg.sender; l.creatorBps = creatorBps;
        // i pool v3 del token esistono gia' come indirizzi (CREATE2 della factory): si chiudono da subito
        l.pools = [_poolFor(token, quote, 100), _poolFor(token, quote, 500), _poolFor(token, quote, 3000), _poolFor(token, quote, 10_000)];
        l.startBlock = uint64(block.number); l.threshold = threshold;
        // pump.fun scalato: Vq0 = 30/85 della soglia -> raccolta a fine curva ~= soglia
        l.virtualQuote = threshold * 30 / 85;
        tokens.push(token);
        feeVault.register(token, msg.sender, creatorBps);
        emit Launched(token, msg.sender, quote, threshold, creatorBps, name, symbol);
    }

    // ---- comprare e vendere ------------------------------------------------

    /// @notice Compra con `quoteIn` di quota (gia' approvata). Con quota WETH si puo' mandare ETH nudo.
    ///         Se la curva finisce, l'eccedenza torna indietro e il lancio gradua nella stessa tx.
    function buy(address token, uint256 quoteIn, uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        Launch storage l = launches[token];
        if (l.token == address(0)) revert Unknown();
        if (l.graduated) revert AlreadyGraduated();
        if (msg.value != 0) {
            if (l.quote != weth) revert NotWETHQuote();
            quoteIn = msg.value;
            IWETHFull(weth).deposit{value: msg.value}();
        } else {
            IERC20(l.quote).safeTransferFrom(msg.sender, address(this), quoteIn);
        }
        if (quoteIn == 0) revert NothingToDo();

        uint256 fee;
        (tokensOut, fee) = quoteBuy(token, quoteIn);
        if (block.number < l.startBlock + SNIPE_BLOCKS) {
            uint256 sold = soldInBlock[token][block.number] + tokensOut;
            if (sold > MAX_EARLY_BUY) revert EarlyBuyTooBig();
            soldInBlock[token][block.number] = sold;
        }
        if (tokensOut < minTokensOut) revert TooLittleOut(tokensOut, minTokensOut);
        if (tokensOut == 0) revert NothingToDo();

        // se la curva si esaurisce si paga solo il necessario, il resto torna
        uint256 spent = quoteIn;
        if (l.tokensSold + tokensOut == CURVE_SUPPLY) {
            (spent, fee) = costFor(token, tokensOut);
            if (spent > quoteIn) { spent = quoteIn; fee = quoteIn * FEE_BPS / 10_000; }
        }
        uint256 refund = quoteIn - spent;
        l.quoteRaised += spent - fee;
        l.tokensSold += tokensOut;

        if (fee != 0) { IERC20(l.quote).forceApprove(address(feeVault), fee); feeVault.deposit(token, l.quote, fee); }
        IERC20(token).safeTransfer(msg.sender, tokensOut);
        if (refund != 0) _payQuote(l.quote, msg.sender, refund, msg.value != 0 && msg.sender.code.length == 0);
        emit Bought(token, msg.sender, spent, fee, tokensOut, l.tokensSold, l.quoteRaised);

        if (l.tokensSold == CURVE_SUPPLY) _graduate(l);
    }

    /// @notice Vende `tokensIn` (gia' approvati) e riceve quota; con quota WETH un wallet riceve ETH nudo, un contratto WETH.
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut) external nonReentrant returns (uint256 quoteOut) {
        Launch storage l = launches[token];
        if (l.token == address(0)) revert Unknown();
        if (l.graduated) revert AlreadyGraduated();
        if (tokensIn == 0) revert NothingToDo();
        uint256 fee;
        (quoteOut, fee) = quoteSell(token, tokensIn);
        if (quoteOut < minQuoteOut) revert TooLittleOut(quoteOut, minQuoteOut);
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        l.tokensSold -= tokensIn;
        l.quoteRaised -= quoteOut + fee;
        if (fee != 0) { IERC20(l.quote).forceApprove(address(feeVault), fee); feeVault.deposit(token, l.quote, fee); }
        _payQuote(l.quote, msg.sender, quoteOut, l.quote == weth && msg.sender.code.length == 0);   // ai contratti WETH, non ETH nudo
        emit Sold(token, msg.sender, tokensIn, quoteOut, fee, l.tokensSold, l.quoteRaised);
    }

    // ---- interno -----------------------------------------------------------

    /// @dev Il pool v3 a range pieno con i 200M e tutta la raccolta, la LP nel vault.
    address private _swapPool;   // il pool autorizzato a chiamare il callback, solo durante la graduazione

    function _graduate(Launch storage l) internal {
        l.graduated = true;
        bool tokenIs0 = l.token < l.quote;
        uint256 quoteAmt = l.quoteRaised;
        uint160 sqrtP = _sqrtPriceX96(tokenIs0 ? LP_SUPPLY : quoteAmt, tokenIs0 ? quoteAmt : LP_SUPPLY);
        (address pool, uint256 tokenAmt, uint256 quoteLeft) = _poolAtTarget(
            tokenIs0 ? l.token : l.quote, tokenIs0 ? l.quote : l.token, tokenIs0, sqrtP, quoteAmt);
        (uint256 tokenId, uint256 usedToken, uint256 usedQuote) = _mintLP(l, tokenIs0, tokenAmt, quoteLeft);
        uint256 leftover = quoteLeft - usedQuote;
        if (leftover != 0) {
            IERC20(l.quote).forceApprove(address(feeVault), leftover);
            feeVault.deposit(l.token, l.quote, leftover);
        }
        uint256 dust = tokenAmt - usedToken;
        if (dust != 0) IERC20(l.token).safeTransfer(0x000000000000000000000000000000000000dEaD, dust);
        l.lpTokenId = tokenId; l.pool = pool;
        emit Graduated(l.token, pool, tokenId, usedToken, usedQuote, leftover);
    }

    function _mintLP(Launch storage l, bool tokenIs0, uint256 tokenAmt, uint256 quoteAmt)
        internal returns (uint256 tokenId, uint256 usedToken, uint256 usedQuote)
    {
        IERC20(l.token).forceApprove(npm, tokenAmt);
        IERC20(l.quote).forceApprove(npm, quoteAmt);
        (uint256 id, , uint256 a0, uint256 a1) = INPMCurve(npm).mint(INPMCurve.MintParams({
            token0: tokenIs0 ? l.token : l.quote, token1: tokenIs0 ? l.quote : l.token, fee: POOL_FEE,
            tickLower: -TICK_EDGE, tickUpper: TICK_EDGE,
            amount0Desired: tokenIs0 ? tokenAmt : quoteAmt, amount1Desired: tokenIs0 ? quoteAmt : tokenAmt,
            amount0Min: 0, amount1Min: 0, recipient: address(feeVault), deadline: block.timestamp
        }));
        return (id, tokenIs0 ? a0 : a1, tokenIs0 ? a1 : a0);
    }

    /// @dev pool creato o riportato al prezzo target; restituisce quanto resta da mettere in LP
    function _poolAtTarget(address t0, address t1, bool tokenIs0, uint160 sqrtP, uint256 quoteAmt)
        internal returns (address pool, uint256 tokenAmt, uint256 quoteLeft)
    {
        tokenAmt = LP_SUPPLY; quoteLeft = quoteAmt;
        pool = IV3FactoryMin(v3Factory).getPool(t0, t1, POOL_FEE);
        if (pool == address(0)) {
            pool = INPMCurve(npm).createAndInitializePoolIfNecessary(t0, t1, POOL_FEE, sqrtP);
            return (pool, tokenAmt, quoteLeft);
        }
        (uint160 cur, , , , , , ) = IV3PoolMin(pool).slot0();
        if (cur == 0) { IV3PoolMin(pool).initialize(sqrtP); return (pool, tokenAmt, quoteLeft); }
        if (cur == sqrtP) return (pool, tokenAmt, quoteLeft);
        bool zeroForOne = cur > sqrtP;                       // prezzo troppo alto: vendiamo token0
        bool payToken = zeroForOne == tokenIs0;              // quale lato paghiamo noi
        uint256 budget = (payToken ? LP_SUPPLY : quoteAmt) * 9 / 10;   // mai tutto: il mint vuole entrambi i lati
        _swapPool = pool;
        (int256 d0, int256 d1) = IV3PoolMin(pool).swap(address(this), zeroForOne, int256(budget), sqrtP, "");
        _swapPool = address(0);
        tokenAmt = uint256(int256(tokenAmt) - (tokenIs0 ? d0 : d1));
        quoteLeft = uint256(int256(quoteLeft) - (tokenIs0 ? d1 : d0));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        if (msg.sender != _swapPool || _swapPool == address(0)) revert Unknown();
        (address t0, address t1) = (address(0), address(0));
        // il pool ci dice cosa deve ricevere; i token vengono dal nostro saldo (from == curve: mai bloccato)
        (bool ok, bytes memory r0) = msg.sender.staticcall(abi.encodeWithSignature("token0()")); require(ok); t0 = abi.decode(r0, (address));
        (ok, r0) = msg.sender.staticcall(abi.encodeWithSignature("token1()")); require(ok); t1 = abi.decode(r0, (address));
        if (a0 > 0) IERC20(t0).safeTransfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20(t1).safeTransfer(msg.sender, uint256(a1));
    }

    function _payQuote(address quote, address to, uint256 amount, bool asEth) internal {
        if (asEth && quote == weth) {
            IWETHFull(weth).withdraw(amount);
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "eth transfer failed");
        } else {
            IERC20(quote).safeTransfer(to, amount);
        }
    }

    function _poolFor(address a, address b, uint24 fee) internal view returns (address) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return _create2(v3Factory, keccak256(abi.encode(t0, t1, fee)), POOL_INIT_CODE_HASH);
    }

    function _create2(address deployer, bytes32 salt, bytes32 initHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash)))));
    }

    /// @dev sqrt(amount1/amount0) * 2^96, con la radice intera su 2^192 * ratio.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        // ratioX192 = amount1 * 2^192 / amount0 puo' traboccare: si passa da X96 in due tempi
        uint256 ratioX96 = (amount1 << 96) / amount0;
        uint256 r = _sqrt(ratioX96) << 48;   // sqrt(ratio * 2^96) * 2^48 = sqrt(ratio) * 2^96
        return uint160(r);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2; y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }
}
