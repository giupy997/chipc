// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RH8State} from "./RH8State.sol";
import {ChipToken} from "./ChipToken.sol";

interface IRH8GateArray {
    function step(uint256 state, uint256 instr, uint256 inPort, uint256 ramData)
        external pure returns (uint256);
}

interface IChip8Renderer {
    function tokenURI(
        uint256 id,
        ChipFactory8.Chip calldata chip,
        string calldata logo
    ) external view returns (string memory);
}

/**
 * @title ChipFactory8 — processori a 8 bit che si possono usare
 *
 * La generazione precedente girava da sola e basta: niente ingressi, niente
 * memoria, quattro bit. Questa prende un byte da chi chiama il clock e ha
 * 256 byte di RAM che restano fra un ciclo e l'altro.
 *
 * ------------------------------------------------------------------------
 *  ROM e RAM stanno qui, non nel silicio
 * ------------------------------------------------------------------------
 * Il processore non contiene ne' programma ne' memoria: li chiede. Espone un
 * indirizzo, questo contratto fa l'accesso. In porte logiche costa zero, e
 * 256 byte come flip-flop sarebbero state duemila porte in piu'.
 *
 * Ne segue che una `LD` prende due cicli. Il contratto deve sapere QUALE
 * indirizzo leggere prima di far girare i gate, ma l'indirizzo lo decide un
 * registro che solo i gate sanno leggere. Allora l'indirizzo si latcha in un
 * ciclo e il dato arriva nel successivo — come nel silicio vero.
 *
 * ------------------------------------------------------------------------
 *  Il clock resta la cosa scarsa
 * ------------------------------------------------------------------------
 * `tick()` e' aperto a chiunque, una volta per blocco. Chi paga incassa la
 * quota di quel ciclo e resta inciso nell'evento come sponsor. Un chip che
 * nessuno fa avanzare e' silicio fermo.
 */
contract ChipFactory8 is ERC721, Ownable {
    using SafeERC20 for IERC20;

    // ---- disposizione della parola macchina --------------------------------
    //   bit   0..170  stato dei flip-flop (171)
    //   bit 176..215  cicli eseguiti da sempre (40)
    //   bit 216..255  blocco dell'ultimo tick (40)
    // Entra tutto in uno slot: un tick resta una sola SSTORE.
    uint256 private constant STATE_MASK = (uint256(1) << 171) - 1;
    uint256 private constant MASK40 = (uint256(1) << 40) - 1;
    uint256 private constant SHIFT_CYCLES = 176;
    uint256 private constant SHIFT_BLOCK = 216;

    uint256 private constant OP_OUT = 22;

    /// ROM: 1024 parole da 25 bit, otto per slot in corsie da 32.
    uint256 public constant ROM_SLOTS = 128;
    /// RAM: 256 byte, trentadue per slot.
    uint256 private constant RAM_SLOTS = 8;

    /**
     * @dev Su una chain Orbit `block.number` NON e' il blocco locale: e' il
     *      blocco della chain madre, che avanza ogni ~12 secondi. Usarlo per
     *      il gate del clock trasformava "un tick per blocco" in un tick
     *      ogni 12 secondi — 0,08 Hz invece di 10, e un'emissione da 90
     *      giorni in una da 29 anni. Il blocco L2 vero lo dice il precompile
     *      ArbSys; il ripiego su block.number serve solo ai test locali,
     *      dove il precompile non esiste.
     */
    address private constant ARB_SYS = address(100);

    function _l2BlockNumber() internal view returns (uint256) {
        (bool ok, bytes memory d) =
            ARB_SYS.staticcall(abi.encodeWithSignature("arbBlockNumber()"));
        return ok && d.length == 32 ? abi.decode(d, (uint256)) : block.number;
    }

    uint256 public constant TICKER_MAX = 8;
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000e18;
    /// @dev Fino al 60% dell'offerta puo' andare alla liquidita'. Oltre,
    ///      l'emissione via cicli diventerebbe una nota a margine.
    uint256 public constant MAX_LIQUIDITY_BPS = 6_000;
    uint256 public constant MIN_TARGET_CYCLES = 100_000;

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

    IRH8GateArray public immutable gates;

    mapping(uint256 => Chip) private _chips;
    mapping(uint256 => uint256[ROM_SLOTS]) private _rom;
    mapping(uint256 => uint256[RAM_SLOTS]) private _ram;
    mapping(uint256 => string) private _logo;
    mapping(bytes32 => uint256) public chipByTicker;
    mapping(address => uint256) public chipByToken;

    uint256 public totalChips;
    uint256 public mintPrice;
    IChip8Renderer public renderer;
    string private _contractURI;

    /// @notice Il token del progetto. Chi conia paga in questo.
    address public motherToken;
    uint256 public mintFee;

    event ChipMinted(uint256 indexed id, address indexed minter, bytes32 indexed ticker, bytes32 label);
    event TokenLaunched(uint256 indexed id, address indexed token, uint256 toLiquidity, uint256 reserve, uint256 rewardPerCycle);
    event Cycle(uint256 indexed id, uint256 indexed cycle, address indexed sponsor, uint16 pc, uint8 inPort, uint8 out, bool halted);
    event Output(uint256 indexed id, uint256 indexed cycle, uint8 value);
    event Halt(uint256 indexed id, uint256 indexed cycle);
    event Rewarded(uint256 indexed id, address indexed sponsor, uint256 amount);
    event ReserveEmpty(uint256 indexed id, uint256 atCycle);
    event Restarted(uint256 indexed id, uint256 atCycle);
    event LogoSet(uint256 indexed id, string uri);
    event MotherTokenSet(address indexed token);

    error NoSuchChip();
    error OneTickPerBlock();
    error AlreadyHalted();
    error NotChipOwner();
    error WrongPayment();
    error TickerTaken(uint256 existingChip);
    error BadTicker();
    error BadLogoURI();
    error BadLiquidityShare();
    error TargetTooShort();
    error MotherAlreadySet();

    constructor(IRH8GateArray gateArray, address owner_)
        ERC721("RH Chip", "CHIP")
        Ownable(owner_)
    {
        gates = gateArray;
    }

    // ---- coniare -----------------------------------------------------------

    function mint(
        uint256[ROM_SLOTS] calldata words,
        bytes32 label,
        bytes32 ticker,
        string calldata logoURI,
        uint16 liquidityBps,
        uint64 targetCycles
    ) external payable returns (uint256 id, address token) {
        if (msg.value != mintPrice) revert WrongPayment();
        if (!_validTicker(ticker)) revert BadTicker();
        if (!_validLogoURI(logoURI)) revert BadLogoURI();
        if (liquidityBps > MAX_LIQUIDITY_BPS) revert BadLiquidityShare();
        if (targetCycles != 0 && targetCycles < MIN_TARGET_CYCLES) revert TargetTooShort();

        uint256 taken = chipByTicker[ticker];
        if (taken != 0) revert TickerTaken(taken);

        _payMintFee();

        unchecked { id = ++totalChips; }
        chipByTicker[ticker] = id;

        Chip storage c = _chips[id];
        c.label = label;
        c.ticker = ticker;
        c.minter = msg.sender;
        c.bornBlock = uint64(_l2BlockNumber());

        _writeRom(id, words);
        if (bytes(logoURI).length != 0) {
            _logo[id] = logoURI;
            emit LogoSet(id, logoURI);
        }
        if (targetCycles != 0) {
            token = _launchToken(id, label, ticker, liquidityBps, targetCycles);
        }

        _safeMint(msg.sender, id);
        emit ChipMinted(id, msg.sender, ticker, label);
    }

    /// @dev Solo le parole non nulle: uno SSTORE a zero e' 20.000 gas buttati,
    ///      e un programma da cinquanta istruzioni ne tocca sette su 128.
    function _writeRom(uint256 id, uint256[ROM_SLOTS] calldata words) internal {
        uint256[ROM_SLOTS] storage rom = _rom[id];
        for (uint256 i; i < ROM_SLOTS; ++i) {
            if (words[i] != 0) rom[i] = words[i];
        }
    }

    function _launchToken(
        uint256 id,
        bytes32 label,
        bytes32 ticker,
        uint16 liquidityBps,
        uint64 targetCycles
    ) internal returns (address token) {
        uint256 toLiquidity = (TOKEN_SUPPLY * liquidityBps) / 10_000;
        uint256 reserve = TOKEN_SUPPLY - toLiquidity;
        uint256 reward = reserve / targetCycles;

        token = address(new ChipToken(
            _toString(label), _toString(ticker), id,
            TOKEN_SUPPLY, address(this), toLiquidity, msg.sender
        ));

        Chip storage c = _chips[id];
        c.token = token;
        c.rewardPerCycle = uint96(reward);
        chipByToken[token] = id;

        emit TokenLaunched(id, token, toLiquidity, reserve, reward);
    }

    // ---- il clock ----------------------------------------------------------

    /**
     * @notice Avanza un chip di un ciclo, dandogli un byte da elaborare.
     * @param id     quale chip
     * @param inPort il byte che il programma legge con `IN`
     *
     * Chiamabile da chiunque, una volta per blocco per chip.
     */
    function tick(uint256 id, uint8 inPort)
        external
        returns (uint16 pc_, uint8 out_, bool halted_)
    {
        Chip storage c = _chips[id];
        if (c.bornBlock == 0) revert NoSuchChip();

        uint256 m = c.machine;
        if (_l2BlockNumber() <= m >> SHIFT_BLOCK) revert OneTickPerBlock();

        uint256 s = m & STATE_MASK;
        if (RH8State.halted(s)) revert AlreadyHalted();

        uint256 instr = _fetch(id, RH8State.pc(s));
        // L'indirizzo e' quello latchato dal ciclo precedente: e' esattamente
        // per questo che una load prende due colpi di clock.
        uint256 ramData = _ramRead(id, RH8State.ramAddr(s));

        uint256 next = gates.step(s, instr, inPort, ramData);
        uint256 cycle = _advance(c, m, next);

        if (RH8State.ramWe(next)) {
            _ramWrite(id, RH8State.ramAddr(next), RH8State.ramWdata(next));
        }

        pc_ = RH8State.pc(next);
        out_ = RH8State.out(next);
        halted_ = RH8State.halted(next);

        // forge-lint: disable-next-line(unsafe-typecast)
        emit Cycle(id, cycle, msg.sender, pc_, inPort, out_, halted_);
        if (instr >> 20 == OP_OUT) emit Output(id, cycle, out_);
        if (halted_) emit Halt(id, cycle);

        _reward(id, c, cycle);
    }

    /// @dev Avanza contatore e blocco in un helper: dentro tick() le
    ///      variabili vive erano gia' al limite dello stack.
    function _advance(Chip storage c, uint256 m, uint256 next)
        internal
        returns (uint256 cycle)
    {
        unchecked { cycle = ((m >> SHIFT_CYCLES) & MASK40) + 1; }
        c.machine = next | (cycle << SHIFT_CYCLES) | (_l2BlockNumber() << SHIFT_BLOCK);
    }

    function _reward(uint256 id, Chip storage c, uint256 cycle) internal {
        uint256 reward = c.rewardPerCycle;
        address token = c.token;
        if (reward == 0 || token == address(0)) return;

        IERC20 t = IERC20(token);
        uint256 left = t.balanceOf(address(this));
        if (left == 0) {
            c.rewardPerCycle = 0;
            emit ReserveEmpty(id, cycle);
            return;
        }
        uint256 pay = reward < left ? reward : left;
        t.safeTransfer(msg.sender, pay);
        emit Rewarded(id, msg.sender, pay);
    }

    // ---- memoria -----------------------------------------------------------

    /// @dev 32 byte per slot: l'indirizzo alto sceglie lo slot, il basso il byte.
    function _ramRead(uint256 id, uint8 addr) internal view returns (uint256) {
        unchecked {
            return (_ram[id][addr >> 5] >> ((addr & 31) * 8)) & 0xff;
        }
    }

    function _ramWrite(uint256 id, uint8 addr, uint8 value) internal {
        unchecked {
            uint256 shift = (addr & 31) * 8;
            uint256 slot = _ram[id][addr >> 5];
            _ram[id][addr >> 5] = (slot & ~(uint256(0xff) << shift)) | (uint256(value) << shift);
        }
    }

    /// @notice Un byte della RAM del chip.
    function ramAt(uint256 id, uint8 addr) external view returns (uint8) {
        return uint8(_ramRead(id, addr));
    }

    /// @notice Tutta la RAM, impacchettata come sta in storage.
    function ram(uint256 id) external view returns (uint256[RAM_SLOTS] memory) {
        return _ram[id];
    }

    /// @dev ROM: otto parole da 25 bit per slot, in corsie da 32.
    function _fetch(uint256 id, uint16 pc) internal view returns (uint256) {
        unchecked {
            return (_rom[id][pc >> 3] >> ((pc & 7) * 32)) & 0x1ffffff;
        }
    }

    function romAt(uint256 id, uint16 pc) external view returns (uint32) {
        return uint32(_fetch(id, pc));
    }

    // ---- proprieta' del chip -----------------------------------------------

    /// @notice Ripartenza. I cicli di vita NON si azzerano, altrimenti
    ///         "questo chip ha macinato N cicli" non vorrebbe dire niente.
    ///         La RAM invece si azzera: e' stato, non storia.
    function restart(uint256 id) external {
        _requireChipOwner(id);
        Chip storage c = _chips[id];
        uint256 cycles = (c.machine >> SHIFT_CYCLES) & MASK40;
        c.machine = cycles << SHIFT_CYCLES;
        unchecked { ++c.resets; }
        uint256[RAM_SLOTS] storage r = _ram[id];
        for (uint256 i; i < RAM_SLOTS; ++i) {
            if (r[i] != 0) r[i] = 0;
        }
        emit Restarted(id, cycles);
    }

    function setLogo(uint256 id, string calldata uri) external {
        _requireChipOwner(id);
        if (!_validLogoURI(uri)) revert BadLogoURI();
        _logo[id] = uri;
        emit LogoSet(id, uri);
    }

    // ---- lettura -----------------------------------------------------------

    function chip(uint256 id) external view returns (Chip memory) {
        if (_chips[id].bornBlock == 0) revert NoSuchChip();
        return _chips[id];
    }

    function logo(uint256 id) external view returns (string memory) { return _logo[id]; }
    function contractURI() external view returns (string memory) { return _contractURI; }

    function inspect(uint256 id)
        external
        view
        returns (uint16 pc, uint8 out, bool halted, uint256 cycles, uint256 lastTickBlock)
    {
        Chip storage c = _chips[id];
        if (c.bornBlock == 0) revert NoSuchChip();
        uint256 m = c.machine;
        uint256 s = m & STATE_MASK;
        return (
            RH8State.pc(s), RH8State.out(s), RH8State.halted(s),
            (m >> SHIFT_CYCLES) & MASK40, m >> SHIFT_BLOCK
        );
    }

    function state(uint256 id) external view returns (uint256) {
        return _chips[id].machine & STATE_MASK;
    }

    function emission(uint256 id)
        external
        view
        returns (address token, uint256 reserveLeft, uint256 rewardPerCycle, uint256 cyclesLeft)
    {
        Chip storage c = _chips[id];
        if (c.bornBlock == 0) revert NoSuchChip();
        token = c.token;
        if (token == address(0)) return (address(0), 0, 0, 0);
        rewardPerCycle = c.rewardPerCycle;
        reserveLeft = IERC20(token).balanceOf(address(this));
        cyclesLeft = rewardPerCycle == 0 ? 0 : reserveLeft / rewardPerCycle;
    }

    function tickerAvailable(bytes32 ticker) external view returns (bool) {
        return _validTicker(ticker) && chipByTicker[ticker] == 0;
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return address(renderer) == address(0)
            ? ""
            : renderer.tokenURI(id, _chips[id], _logo[id]);
    }

    // ---- amministrazione ---------------------------------------------------

    function setRenderer(IChip8Renderer r) external onlyOwner { renderer = r; }
    function setMintPrice(uint256 p) external onlyOwner { mintPrice = p; }
    function setContractURI(string calldata uri) external onlyOwner { _contractURI = uri; }
    function setMintFee(uint256 f) external onlyOwner { mintFee = f; }

    /**
     * @notice Lega la fabbrica al token del progetto. Una volta sola.
     * @dev Cambiarlo dopo vorrebbe dire spostare a piacere dove finiscono le
     *      quote di conio, sotto chi ha gia' coniato.
     */
    function setMotherToken(address token) external onlyOwner {
        if (motherToken != address(0)) revert MotherAlreadySet();
        motherToken = token;
        emit MotherTokenSet(token);
    }

    function withdraw(address payable to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    // ---- interno -----------------------------------------------------------

    /// @dev La quota di conio si paga nel token del progetto e resta qui.
    function _payMintFee() internal {
        address mt = motherToken;
        if (mt == address(0) || mintFee == 0) return;
        IERC20(mt).safeTransferFrom(msg.sender, address(this), mintFee);
    }

    function _requireChipOwner(uint256 id) internal view {
        if (_ownerOf(id) != msg.sender) revert NotChipOwner();
    }

    function _toString(bytes32 raw) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && raw[len] != 0) {
            unchecked { ++len; }
        }
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) out[i] = raw[i];
        return string(out);
    }

    function _validTicker(bytes32 t) internal pure returns (bool) {
        uint256 len;
        while (len < 32 && t[len] != 0) {
            uint8 ch = uint8(t[len]);
            bool ok = (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x30 && ch <= 0x39) || ch == 0x2d;
            if (!ok) return false;
            unchecked { ++len; }
        }
        if (len == 0 || len > TICKER_MAX) return false;
        for (uint256 i = len; i < 32; ++i) {
            if (t[i] != 0) return false;
        }
        return true;
    }

    function _validLogoURI(string calldata s) internal pure returns (bool) {
        bytes calldata b = bytes(s);
        if (b.length == 0) return true;
        if (b.length > 200) return false;

        bool https = b.length >= 8 && bytes8(b[:8]) == bytes8("https://");
        bool ipfs = b.length >= 7 && bytes7(b[:7]) == bytes7("ipfs://");
        if (!https && !ipfs) return false;

        for (uint256 i; i < b.length; ++i) {
            uint8 ch = uint8(b[i]);
            if (ch < 0x21 || ch > 0x7e) return false;
            if (ch == 0x22 || ch == 0x5c) return false;
        }
        return true;
    }
}
