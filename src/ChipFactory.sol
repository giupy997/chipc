// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RH4State} from "./RH4State.sol";
import {ChipToken} from "./ChipToken.sol";

interface IRH4GateArray {
    function step(uint256 state, uint256 instr) external pure returns (uint256);
    function run(uint256 state, uint256[16] calldata rom, uint256 maxCycles)
        external pure returns (uint256 finalState, uint256 executed);
}

interface IChipRenderer {
    function tokenURI(
        uint256 id,
        ChipFactory.Chip calldata chip,
        uint256[16] calldata rom,
        string calldata logo
    ) external view returns (string memory);
}

/**
 * @title ChipFactory — chi vuole un processore se lo conia
 *
 * Ogni chip e' un NFT e insieme una RH-4 vera: 79 bit di stato tutti suoi,
 * la sua ROM, il suo contatore di cicli. Il silicio invece e' uno solo per
 * tutta la chain — RH4GateArray — e i chip lo chiamano. Coniare un chip
 * scrive cinque slot di storage, non 18 kB di bytecode.
 *
 * ------------------------------------------------------------------------
 *  Il clock e' la cosa scarsa, non il chip.
 * ------------------------------------------------------------------------
 * Fabbricare un processore costa spiccioli. Tenerlo acceso no: un ciclo per
 * blocco, e ogni ciclo lo deve pagare qualcuno. `tick()` e' aperto a
 * chiunque — non al proprietario, a chiunque — e chi paga resta inciso
 * nell'evento `Cycle` come sponsor di quel ciclo. Un chip che nessuno fa
 * avanzare e' silicio morto in storage.
 *
 * Il contatore dei cicli e' monotono per tutta la vita del chip: `reset()`
 * fa ripartire il processore ma non azzera quanto ha macinato. Cosi'
 * "questo chip ha eseguito N cicli" resta una cosa che si puo' credere.
 *
 * ------------------------------------------------------------------------
 *  Ogni chip ha il suo token, e i cicli sono l'unico modo di guadagnarlo.
 * ------------------------------------------------------------------------
 * Al conio nasce un ChipToken con il nome e la sigla scelti: offerta fissa,
 * un miliardo, mai piu' toccabile — quel contratto non ha una `mint`.
 *
 * Una fetta va subito a chi conia, per la liquidita'. Tutto il resto resta
 * qui e ne esce **un ciclo di clock alla volta**, verso chi quel ciclo l'ha
 * pagato. Non c'e' un secondo modo di estrarlo.
 *
 * Ne segue la proprieta' che regge tutto: **un chip gira alla velocita' che
 * il mercato pensa che meriti**. Se il token vale piu' del gas di un tick,
 * qualcuno lo chiama e il processore resta acceso. Se non vale, si ferma.
 * L'emissione non e' governata da un'autorita' ma dal block time: nessuno
 * puo' stampare piu' in fretta di quanto la chain chiuda i blocchi.
 */
contract ChipFactory is ERC721, Ownable {
    using SafeERC20 for IERC20;
    // ---- disposizione della parola macchina --------------------------------
    //   bit   0..78   stato dei flip-flop (registri, pc, flag, uscita)
    //   bit  80..127  cicli eseguiti da sempre (monotono)
    //   bit 128..175  blocco dell'ultimo tick
    uint256 private constant STATE_MASK = (uint256(1) << 79) - 1;
    uint256 private constant MASK48 = (uint256(1) << 48) - 1;
    uint256 private constant SHIFT_CYCLES = 80;
    uint256 private constant SHIFT_BLOCK = 128;

    uint256 private constant OP_OUT = 0xe;
    uint256 public constant ROM_SLOTS = 16;

    struct Chip {
        uint256 machine;   // stato | cicli | ultimo blocco
        bytes32 label;     // nome esteso, fino a 32 caratteri
        bytes32 ticker;    // sigla, 1-8 caratteri, unica in tutta la fabbrica
        address minter;    // chi l'ha coniato: non cambia mai   160 bit
        uint64 bornBlock;  // 0 = il chip non esiste              64 bit
        uint32 resets;     //                                     32 bit
        address token;     // il suo ERC-20                      160 bit
        uint96 rewardPerCycle; // quanto prende lo sponsor        96 bit
    }

    uint256 public constant TICKER_MAX = 8;

    /// Un miliardo con 18 decimali: e' quello che i launchpad si aspettano.
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000e18;
    /// Alla liquidita' non puo' andare piu' della meta': i cicli devono
    /// restare il modo principale con cui il token si distribuisce.
    uint256 public constant MAX_LIQUIDITY_BPS = 5_000;
    /// Sotto questa soglia la riserva si prosciugherebbe in pochi minuti.
    uint256 public constant MIN_TARGET_CYCLES = 100_000;

    IRH4GateArray public immutable gates;

    mapping(uint256 => Chip) private _chips;
    /// @dev Fuori dalla struct: un chip senza logo non paga niente per averne
    ///      il posto. Vuoto = l'NFT mostra la card generata.
    mapping(uint256 => string) private _logo;
    mapping(uint256 => uint256[ROM_SLOTS]) private _rom;

    /// @dev Sigla gia' presa -> id del chip che ce l'ha. Senza questo
    ///      chiunque potrebbe coniare un chip con la sigla di un altro.
    mapping(bytes32 => uint256) public chipByTicker;

    /// @dev Token gia' agganciato -> chip che lo usa. La riserva di un chip
    ///      e' il saldo che questo contratto ha di quel token: due chip sullo
    ///      stesso token si mangerebbero la riserva a vicenda.
    mapping(address => uint256) public chipByToken;

    uint256 public totalChips;
    uint256 public mintPrice;
    string private _contractURI;

    /// @notice Il chip madre: il primo, quello da cui discende la fabbrica.
    ///         Si fissa una volta sola e non si sposta piu'.
    uint256 public motherChip;
    /// @notice Quota di conio in token della madre. Zero = conio libero.
    uint256 public mintPriceToken;
    IChipRenderer public renderer;

    event ChipMinted(
        uint256 indexed id,
        address indexed minter,
        bytes32 indexed ticker,
        bytes32 label,
        bytes32 programHash
    );
    event Cycle(
        uint256 indexed id,
        uint256 indexed cycle,
        address indexed sponsor,
        uint8 pc,
        uint16 instr,
        uint8 out,
        bool halted
    );
    /// @notice E' nato il token di un chip.
    event TokenLaunched(
        uint256 indexed id,
        address indexed token,
        uint256 toLiquidity,
        uint256 reserve,
        uint256 rewardPerCycle
    );
    /// @notice E' stato designato il chip madre.
    event MotherSet(uint256 indexed id, address indexed token);
    /// @notice Una quota di conio e' finita nella riserva della madre.
    event MotherFee(uint256 indexed newChip, address indexed payer, uint256 amount);

    /// @notice A un chip senza token ne e' stato agganciato uno.
    event TokenAttached(uint256 indexed id, address indexed token, uint256 rewardPerCycle);
    /// @notice Il logo di un chip e' stato impostato o cambiato.
    event LogoSet(uint256 indexed id, string uri);
    /// @notice Un ciclo ha pagato il suo sponsor.
    event Rewarded(uint256 indexed id, address indexed sponsor, uint256 amount);
    /// @notice La riserva di emissione e' finita: da qui il clock e' gratuito.
    event ReserveEmpty(uint256 indexed id, uint256 atCycle);

    event Output(uint256 indexed id, uint256 indexed cycle, uint8 value);
    event Halt(uint256 indexed id, uint256 indexed cycle);
    event Reprogrammed(uint256 indexed id, bytes32 programHash);
    event Restarted(uint256 indexed id, uint256 atCycle);

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
    error TokenAlreadySet();
    error TokenInUse(uint256 existingChip);
    error NoToken();
    error MotherAlreadySet();
    error NoMother();

    constructor(IRH4GateArray gateArray, address owner_)
        ERC721("RH-4 Chip", "CHIP")
        Ownable(owner_)
    {
        gates = gateArray;
    }

    // ---- coniare -----------------------------------------------------------

    /**
     * @notice Conia un chip nuovo con il suo programma.
     * @dev Non controlliamo che il programma non contenga HLT: costerebbe
     *      centinaia di migliaia di gas eseguirlo qui. Il controllo si fa
     *      prima e gratis con `previewProgram`, che gira via `eth_call`.
     *      Un chip che si ferma e' comunque recuperabile con `restart`.
     */
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
        _payMotherFee();
        if (liquidityBps > MAX_LIQUIDITY_BPS) revert BadLiquidityShare();
        // targetCycles == 0 vuol dire "niente token adesso": il chip nasce
        // nudo e piu' avanti gli si aggancia un token lanciato altrove, per
        // esempio da un launchpad che vuole creare il proprio contratto.
        if (targetCycles != 0 && targetCycles < MIN_TARGET_CYCLES) revert TargetTooShort();

        uint256 taken = chipByTicker[ticker];
        if (taken != 0) revert TickerTaken(taken);

        unchecked { id = ++totalChips; }
        chipByTicker[ticker] = id;

        Chip storage c = _chips[id];
        c.label = label;
        c.ticker = ticker;
        c.minter = msg.sender;
        c.bornBlock = uint64(block.number);

        _writeRom(id, words);
        if (bytes(logoURI).length != 0) {
            _logo[id] = logoURI;
            emit LogoSet(id, logoURI);
        }

        if (targetCycles != 0) {
            token = _launchToken(id, label, ticker, liquidityBps, targetCycles);
        }

        _safeMint(msg.sender, id);
        emit ChipMinted(id, msg.sender, ticker, label, keccak256(abi.encode(words)));
    }

    /**
     * @dev Il token nasce qui e la riserva resta a questo contratto: da li'
     *      esce solo passando per tick(). Sta in una funzione a parte perche'
     *      dentro mint() erano troppe variabili vive insieme.
     *
     *      Il premio si calcola PRIMA di dare via la fetta di liquidita',
     *      altrimenti dipenderebbe da cosa il minter ci fa dopo.
     */
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

        token = address(
            new ChipToken(
                _toString(label),
                _toString(ticker),
                id,
                TOKEN_SUPPLY,
                address(this),
                toLiquidity,
                msg.sender
            )
        );

        Chip storage c = _chips[id];
        c.token = token;
        c.rewardPerCycle = uint96(reward);
        chipByToken[token] = id;

        emit TokenLaunched(id, token, toLiquidity, reserve, reward);
    }

    /**
     * @notice Designa il chip madre. Una volta sola: se il proprietario
     *         potesse spostarla, "madre" smetterebbe di voler dire qualcosa.
     */
    function setMother(uint256 id) external onlyOwner {
        if (motherChip != 0) revert MotherAlreadySet();
        Chip storage c = _chips[id];
        if (c.bornBlock == 0) revert NoSuchChip();
        if (c.token == address(0)) revert NoToken();
        motherChip = id;
        emit MotherSet(id, c.token);
    }

    /// @notice Quanto costa coniare, in token della madre.
    function setMintPriceToken(uint256 p) external onlyOwner {
        mintPriceToken = p;
    }

    /// @notice Il token del chip madre, se e' stata designata.
    function motherToken() public view returns (address) {
        return motherChip == 0 ? address(0) : _chips[motherChip].token;
    }

    /**
     * @dev La quota di conio finisce a questo contratto. E qui c'e' il punto:
     *      la riserva di un chip *e'* il saldo che la fabbrica ha del suo
     *      token. Quindi la quota non va in tasca a nessuno — allunga la vita
     *      del clock della madre, cioe' paga chi la tiene accesa.
     *
     *      Coniare un chip nuovo finanzia chi fa girare il primo.
     */
    function _payMotherFee() internal {
        uint256 fee = mintPriceToken;
        if (fee == 0) return;

        address mt = motherToken();
        if (mt == address(0)) revert NoMother();

        IERC20(mt).safeTransferFrom(msg.sender, address(this), fee);
        emit MotherFee(totalChips + 1, msg.sender, fee);
    }

    /// @dev Scrive solo le parole non nulle: una ROM da 42 istruzioni ne
    ///      occupa tre su sedici, e uno SSTORE a zero e' 20.000 gas buttati.
    ///      Sta a parte perche' dentro mint() teneva vive troppe variabili.
    function _writeRom(uint256 id, uint256[ROM_SLOTS] calldata words) internal {
        uint256[ROM_SLOTS] storage rom = _rom[id];
        for (uint256 i; i < ROM_SLOTS; ++i) {
            if (words[i] != 0) rom[i] = words[i];
        }
    }

    // ---- il clock ----------------------------------------------------------

    /**
     * @notice Avanza un chip di un ciclo. Chiunque puo' chiamarla, una volta
     *         per blocco per chip. Non serve possedere il chip: serve solo
     *         essere disposto a pagare quel ciclo.
     */
    function tick(uint256 id)
        external
        returns (uint8 pc_, uint8 out_, bool halted_)
    {
        Chip storage c = _chips[id];
        if (c.bornBlock == 0) revert NoSuchChip();

        uint256 m = c.machine;
        if (block.number <= m >> SHIFT_BLOCK) revert OneTickPerBlock();

        uint256 s = m & STATE_MASK;
        if (RH4State.halted(s)) revert AlreadyHalted();

        uint256 instr = _fetch(id, RH4State.pc(s));
        uint256 next = gates.step(s, instr);
        uint256 cycle;
        unchecked { cycle = ((m >> SHIFT_CYCLES) & MASK48) + 1; }

        c.machine = next | (cycle << SHIFT_CYCLES) | (block.number << SHIFT_BLOCK);

        pc_ = RH4State.pc(next);
        out_ = RH4State.out(next);
        halted_ = RH4State.halted(next);

        // _fetch maschera a 12 bit: il cast a uint16 non puo' troncare
        // forge-lint: disable-next-line(unsafe-typecast)
        emit Cycle(id, cycle, msg.sender, pc_, uint16(instr), out_, halted_);
        if (instr >> 8 == OP_OUT) emit Output(id, cycle, out_);
        if (halted_) emit Halt(id, cycle);

        _reward(id, c, cycle);
    }

    /**
     * @dev Paga lo sponsor del ciclo appena eseguito. Quando la riserva
     *      finisce il clock NON si ferma: continua a girare gratis. Un chip
     *      senza piu' token da distribuire e' ancora un processore acceso,
     *      solo che da li' in poi lo si tiene vivo per il gusto di farlo.
     */
    function _reward(uint256 id, Chip storage c, uint256 cycle) internal {
        uint256 reward = c.rewardPerCycle;
        address token = c.token;
        if (reward == 0 || token == address(0)) return;

        IERC20 t = IERC20(token);
        uint256 left = t.balanceOf(address(this));
        // Riserva vuota: il clock continua, semplicemente gratis. Il premio
        // NON si azzera, perche' la riserva e' il saldo di questo contratto e
        // qualcuno puo' sempre ricaricarla — le quote di conio fanno esatta-
        // mente questo. Azzerarlo avrebbe ucciso ogni pagamento successivo.
        if (left == 0) return;

        uint256 pay = reward < left ? reward : left;
        t.safeTransfer(msg.sender, pay);
        emit Rewarded(id, msg.sender, pay);

        // il ciclo che prosciuga la riserva lo diciamo una volta sola
        if (pay == left) emit ReserveEmpty(id, cycle);
    }

    // ---- proprieta' del chip -----------------------------------------------

    /**
     * @notice Rimette il processore allo stato iniziale. Il conteggio dei
     *         cicli NON riparte da zero: quello che il chip ha macinato resta
     *         scritto, altrimenti "cicli eseguiti" non vorrebbe dire niente.
     */
    function restart(uint256 id) external {
        _requireChipOwner(id);
        Chip storage c = _chips[id];
        uint256 cycles = (c.machine >> SHIFT_CYCLES) & MASK48;
        c.machine = cycles << SHIFT_CYCLES; // stato a zero, lastTickBlock a zero
        unchecked { ++c.resets; }
        emit Restarted(id, cycles);
    }

    /// @notice Sostituisce il programma. La ROM sta fuori dalla netlist
    ///         apposta: si cambia il software senza toccare l'hardware.
    function reprogram(uint256 id, uint256[ROM_SLOTS] calldata words) external {
        _requireChipOwner(id);
        uint256[ROM_SLOTS] storage rom = _rom[id];
        for (uint256 i; i < ROM_SLOTS; ++i) {
            if (rom[i] != words[i]) rom[i] = words[i];
        }
        Chip storage c = _chips[id];
        uint256 cycles = (c.machine >> SHIFT_CYCLES) & MASK48;
        c.machine = cycles << SHIFT_CYCLES;
        unchecked { ++c.resets; }
        emit Reprogrammed(id, keccak256(abi.encode(words)));
    }

    /**
     * @notice Aggancia a un chip nudo un token lanciato altrove.
     *
     * Serve quando il token lo crea un launchpad, che vuole per forza
     * distribuire il proprio contratto: la fabbrica non ha bisogno di
     * *creare* il token, le basta sapere qual e' e avere qualcosa da
     * distribuire. La riserva e' semplicemente il saldo che questo contratto
     * ha di quel token: per finanziarla basta trasferirglieli.
     *
     * @dev Si puo' fare **una volta sola**. Se il proprietario potesse
     *      cambiare il token dopo, chi ha macinato cicli per guadagnarlo si
     *      ritroverebbe in mano la cosa sbagliata.
     */
    function attachToken(uint256 id, address token, uint96 rewardPerCycle) external {
        _requireChipOwner(id);
        if (token == address(0)) revert NoToken();

        Chip storage c = _chips[id];
        if (c.token != address(0)) revert TokenAlreadySet();

        uint256 used = chipByToken[token];
        if (used != 0) revert TokenInUse(used);

        c.token = token;
        c.rewardPerCycle = rewardPerCycle;
        chipByToken[token] = id;

        emit TokenAttached(id, token, rewardPerCycle);
    }

    /**
     * @notice Cambia il logo del chip.
     * @dev Modificabile apposta: un URI rotto o un'immagine sparita
     *      renderebbero l'NFT muto per sempre. Il rovescio e' che chi compra
     *      deve sapere che l'immagine puo' cambiare sotto di lui — a
     *      differenza della sigla e del token, che non si toccano piu'.
     */
    function setLogo(uint256 id, string calldata uri) external {
        _requireChipOwner(id);
        if (!_validLogoURI(uri)) revert BadLogoURI();
        _logo[id] = uri;
        emit LogoSet(id, uri);
    }

    function logo(uint256 id) external view returns (string memory) {
        return _logo[id];
    }

    /// @notice Metadati della collezione, non del singolo chip. E' qui che
    ///         vive il marchio della fabbrica.
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    // ---- lettura -----------------------------------------------------------

    function chip(uint256 id) external view returns (Chip memory) {
        if (_chips[id].bornBlock == 0) revert NoSuchChip();
        return _chips[id];
    }

    function program(uint256 id) external view returns (uint256[ROM_SLOTS] memory) {
        return _rom[id];
    }

    /// @notice Program counter, uscita, halt, cicli e ultimo blocco toccato.
    function inspect(uint256 id)
        external
        view
        returns (uint8 pc, uint8 out, bool halted, uint256 cycles, uint256 lastTickBlock)
    {
        Chip storage c = _chips[id];
        if (c.bornBlock == 0) revert NoSuchChip();
        uint256 m = c.machine;
        uint256 s = m & STATE_MASK;
        return (
            RH4State.pc(s),
            RH4State.out(s),
            RH4State.halted(s),
            (m >> SHIFT_CYCLES) & MASK48,
            m >> SHIFT_BLOCK
        );
    }

    /// @notice I 79 bit grezzi: il frontend ci disegna registri e flag.
    function state(uint256 id) external view returns (uint256) {
        return _chips[id].machine & STATE_MASK;
    }

    /// @notice Istruzione all'indirizzo `pc` della ROM del chip.
    function romAt(uint256 id, uint8 pc) external view returns (uint16) {
        return uint16(_fetch(id, pc));
    }

    /// @notice Dove finirebbe il chip dopo `n` cicli, senza toccare nulla.
    function preview(uint256 id, uint256 n)
        external
        view
        returns (uint8 pc, uint8 out, bool halted, uint256 executed)
    {
        Chip storage c = _chips[id];
        if (c.bornBlock == 0) revert NoSuchChip();
        (uint256 s, uint256 ran) =
            gates.run(c.machine & STATE_MASK, _rom[id], n);
        return (RH4State.pc(s), RH4State.out(s), RH4State.halted(s), ran);
    }

    /**
     * @notice Prova un programma PRIMA di coniarlo. Da chiamare via
     *         `eth_call`: non costa niente e dice se il programma si ferma.
     *         Un chip che incontra HLT smette di essere interessante.
     */
    function previewProgram(uint256[ROM_SLOTS] calldata rom, uint256 n)
        external
        view
        returns (bool halts, uint256 executed, uint8 out)
    {
        (uint256 s, uint256 ran) = gates.run(0, rom, n);
        return (RH4State.halted(s), ran, RH4State.out(s));
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return address(renderer) == address(0)
            ? ""
            : renderer.tokenURI(id, _chips[id], _rom[id], _logo[id]);
    }

    // ---- amministrazione ---------------------------------------------------

    function setRenderer(IChipRenderer r) external onlyOwner { renderer = r; }
    function setMintPrice(uint256 p) external onlyOwner { mintPrice = p; }
    function setContractURI(string calldata uri) external onlyOwner { _contractURI = uri; }

    function withdraw(address payable to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    // ---- interno -----------------------------------------------------------

    function _fetch(uint256 id, uint8 pc) internal view returns (uint256) {
        unchecked {
            return (_rom[id][pc >> 4] >> ((pc & 15) * 16)) & 0xfff;
        }
    }

    /**
     * @dev Una sigla valida e' 1-8 caratteri fra A-Z, 0-9 e trattino, seguiti
     *      solo da zeri. Il vincolo non e' estetico: la sigla e' identita', e
     *      due chip che si chiamano uguale in minuscolo e maiuscolo sono un
     *      invito all'inganno.
     */
    function _validTicker(bytes32 t) internal pure returns (bool) {
        uint256 len;
        while (len < 32 && t[len] != 0) {
            uint8 ch = uint8(t[len]);
            bool ok = (ch >= 0x41 && ch <= 0x5a)   // A-Z
                || (ch >= 0x30 && ch <= 0x39)      // 0-9
                || ch == 0x2d;                     // -
            if (!ok) return false;
            unchecked { ++len; }
        }
        if (len == 0 || len > TICKER_MAX) return false;
        // niente caratteri dopo il primo zero: due sigle non devono poter
        // avere gli stessi byte visibili ed essere considerate diverse
        for (uint256 i = len; i < 32; ++i) {
            if (t[i] != 0) return false;
        }
        return true;
    }

    /// @notice Quanto resta da distribuire e quanto prende un ciclo.
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

    /// @notice La sigla e' libera? Da chiamare prima di coniare.
    function tickerAvailable(bytes32 ticker) external view returns (bool) {
        return _validTicker(ticker) && chipByTicker[ticker] == 0;
    }

    /// @dev bytes32 -> stringa, tagliando gli zeri di coda. Serve per dare
    ///      nome e simbolo al token: lo storage li tiene compatti, l'ERC-20
    ///      li vuole come stringhe.
    function _toString(bytes32 raw) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && raw[len] != 0) {
            unchecked { ++len; }
        }
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) out[i] = raw[i];
        return string(out);
    }

    /**
     * @dev Un URI di logo valido e' vuoto, oppure https:// o ipfs:// seguito
     *      da soli caratteri ASCII stampabili senza virgolette ne' barre
     *      rovesce.
     *
     *      I tre vincoli servono a tre cose diverse: lo schema tiene fuori
     *      `javascript:` e `data:text/html`, che in certi visualizzatori
     *      diventano codice; le virgolette e la barra rovescia romperebbero
     *      il JSON dei metadati; e il resto tiene fuori spazi e caratteri di
     *      controllo, che lo romperebbero comunque.
     */
    function _validLogoURI(string calldata s) internal pure returns (bool) {
        bytes calldata b = bytes(s);
        if (b.length == 0) return true;
        if (b.length > 200) return false;

        bool https = b.length >= 8;
        if (https) {
            bytes8 head = bytes8(b[:8]);
            https = head == bytes8("https://");
        }
        bool ipfs = b.length >= 7;
        if (ipfs) {
            bytes7 head = bytes7(b[:7]);
            ipfs = head == bytes7("ipfs://");
        }
        if (!https && !ipfs) return false;

        for (uint256 i; i < b.length; ++i) {
            uint8 ch = uint8(b[i]);
            if (ch < 0x21 || ch > 0x7e) return false;   // spazi e controllo
            if (ch == 0x22 || ch == 0x5c) return false; // " e \\
        }
        return true;
    }

    function _requireChipOwner(uint256 id) internal view {
        if (_ownerOf(id) != msg.sender) revert NotChipOwner();
    }
}
