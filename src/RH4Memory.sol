// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title RH4Memory — le memory card
 *
 * Un NFT con una capacita'. Due nature:
 *
 *   ON-CHAIN  i byte stanno QUI, nello storage di questo contratto, 32 per
 *             slot. Chi possiede la card scrive a offset, chiunque legge.
 *             Nessun link, nessun server: la memoria vive dentro la chain.
 *   PINNED    la card tiene solo l'hash e l'URI del contenuto (IPFS,
 *             Arweave); i byte stanno fuori. Per i file grandi, e per i siti:
 *             una card puo' prendere un NOME, e il sito lo serve come
 *             nome.rh4cpu.tech leggendo l'URI da qui.
 *
 * Sigillo: il proprietario puo' sigillare una card. Da quel momento non si
 * scrive piu', per nessuno, per sempre. Un archivio con data certa.
 *
 * Si paga in RH4, e l'RH4 va nella fabbrica della madre: riserva di
 * mining, a chi tiene accesi i chip. L'owner regola solo i tagli e i
 * prezzi; non puo' toccare i byte di nessuno.
 */
contract RH4Memory is ERC721, Ownable {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    struct Kind {
        uint32 capacity;    // byte, per le on-chain; indicativo per le pinned (0 = senza limite dichiarato)
        bool onchain;
        bool enabled;
        uint256 price;      // in RH4 (wei)
        string name;        // "4K", "64K", "32M"...
    }

    struct Card {
        uint16 kind;
        bool locked;        // sigillata: non si scrive piu'
        uint32 used;        // ultimo byte scritto + 1 (on-chain)
        uint64 born;
        uint32 writes;
        bytes32 label;      // 32 byte di nome libero
    }

    IERC20 public immutable rh4;
    address public immutable sink;      // la fabbrica della madre: qui atterra l'RH4 pagato

    Kind[] public kinds;
    uint256 public totalCards;
    mapping(uint256 => Card) private _cards;
    mapping(uint256 => mapping(uint256 => bytes32)) private _data;   // card -> slot -> 32 byte
    mapping(uint256 => string) private _uri;                          // pinned: dove stanno i byte
    mapping(uint256 => bytes32) private _contentHash;                 // pinned: l'impronta del contenuto
    mapping(uint256 => string) private _nameOf;                       // card -> nome (siti)
    mapping(bytes32 => uint256) public cardByName;                    // keccak(nome) -> card

    uint256 public constant MAX_NAME = 32;

    event KindSet(uint256 indexed kind, string name, uint32 capacity, bool onchain, uint256 price, bool enabled);
    event CardMinted(uint256 indexed id, address indexed owner, uint256 indexed kind, bytes32 label, uint256 paid);
    event Written(uint256 indexed id, uint256 offset, uint256 length, address indexed by);
    event Cleared(uint256 indexed id);
    event ContentSet(uint256 indexed id, bytes32 contentHash, string uri);
    event NameSet(uint256 indexed id, string name);
    event Sealed(uint256 indexed id, uint256 atBlock);
    event LabelSet(uint256 indexed id, bytes32 label);

    error NoSuchKind();
    error KindDisabled();
    error NotCardOwner();
    error CardSealed();
    error OutOfBounds();
    error NotOnChain();
    error NotPinned();
    error BadName();
    error NameTaken(uint256 byCard);
    error NoSuchCard();

    constructor(IERC20 rh4_, address sink_, address owner_) ERC721("RH-4 Memory Card", "CARD") Ownable(owner_) {
        rh4 = rh4_;
        sink = sink_;
    }

    // ---- i tagli ---------------------------------------------------------

    function setKind(uint256 kind, string calldata name, uint32 capacity, bool onchain, uint256 price, bool enabled) external onlyOwner {
        if (kind > kinds.length) revert NoSuchKind();
        if (kind == kinds.length) kinds.push();
        Kind storage k = kinds[kind];
        k.name = name; k.capacity = capacity; k.onchain = onchain; k.price = price; k.enabled = enabled;
        emit KindSet(kind, name, capacity, onchain, price, enabled);
    }

    function kindCount() external view returns (uint256) { return kinds.length; }

    // ---- comprare --------------------------------------------------------

    /// @notice Una card nuova. L'RH4 va dritto alla fabbrica della madre.
    function mint(uint256 kind, bytes32 label) external returns (uint256 id) {
        if (kind >= kinds.length) revert NoSuchKind();
        Kind storage k = kinds[kind];
        if (!k.enabled) revert KindDisabled();
        if (k.price != 0) rh4.safeTransferFrom(msg.sender, sink, k.price);
        unchecked { id = ++totalCards; }
        _cards[id] = Card({ kind: uint16(kind), locked: false, used: 0, born: uint64(block.number), writes: 0, label: label });
        _safeMint(msg.sender, id);
        emit CardMinted(id, msg.sender, kind, label, k.price);
    }

    // ---- scrivere (on-chain) ---------------------------------------------

    /// @notice Scrive `data` a partire da `offset`. Solo il proprietario, mai su una card sigillata.
    function write(uint256 id, uint256 offset, bytes calldata data) external {
        Card storage c = _requireWritable(id);
        Kind storage k = kinds[c.kind];
        if (!k.onchain) revert NotOnChain();
        if (data.length == 0) return;
        uint256 end = offset + data.length;
        if (end > k.capacity) revert OutOfBounds();

        // slot per slot: si legge la parola, si sostituiscono i byte toccati, si riscrive
        uint256 slot = offset / 32;
        uint256 lastSlot = (end - 1) / 32;
        uint256 di;                      // indice dentro data
        for (; slot <= lastSlot; ++slot) {
            uint256 from = slot == offset / 32 ? offset % 32 : 0;
            uint256 to = slot == lastSlot ? ((end - 1) % 32) + 1 : 32;
            if (from == 0 && to == 32) {
                // parola intera: si copia in blocco, niente giro sui byte
                _data[id][slot] = bytes32(data[di:di + 32]);
                unchecked { di += 32; }
                continue;
            }
            bytes32 word = _data[id][slot];
            for (uint256 b = from; b < to; ++b) {
                word = (word & ~(bytes32(uint256(0xff) << ((31 - b) * 8)))) | (bytes32(uint256(uint8(data[di])) << ((31 - b) * 8)));
                unchecked { ++di; }
            }
            _data[id][slot] = word;
        }
        if (end > c.used) c.used = uint32(end);
        unchecked { ++c.writes; }
        emit Written(id, offset, data.length, msg.sender);
    }

    /// @notice Azzera i byte usati (torna una card vuota). Solo il proprietario, mai sigillata.
    function clear(uint256 id) external {
        Card storage c = _requireWritable(id);
        if (!kinds[c.kind].onchain) revert NotOnChain();
        uint256 slots = (uint256(c.used) + 31) / 32;
        for (uint256 s; s < slots; ++s) delete _data[id][s];
        c.used = 0;
        emit Cleared(id);
    }

    // ---- scrivere (pinned) -----------------------------------------------

    /// @notice L'impronta e l'indirizzo del contenuto fuori chain (ipfs://, ar://).
    function setContent(uint256 id, bytes32 contentHash, string calldata uri) external {
        Card storage c = _requireWritable(id);
        if (kinds[c.kind].onchain) revert NotPinned();
        _contentHash[id] = contentHash;
        _uri[id] = uri;
        unchecked { ++c.writes; }
        emit ContentSet(id, contentHash, uri);
    }

    /// @notice Un nome per la card: minuscole, cifre, trattino, 3-32. Per i siti: nome.rh4cpu.tech.
    function setName(uint256 id, string calldata name) external {
        if (ownerOf(id) != msg.sender) revert NotCardOwner();
        bytes memory b = bytes(name);
        if (b.length < 3 || b.length > MAX_NAME || b[0] == "-" || b[b.length - 1] == "-") revert BadName();
        for (uint256 i; i < b.length; ++i) {
            uint8 ch = uint8(b[i]);
            if (!((ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39) || ch == 0x2d)) revert BadName();
        }
        bytes32 key = keccak256(b);
        uint256 taken = cardByName[key];
        if (taken != 0 && taken != id) revert NameTaken(taken);
        // il nome vecchio si libera
        bytes memory old = bytes(_nameOf[id]);
        if (old.length != 0) delete cardByName[keccak256(old)];
        _nameOf[id] = name;
        cardByName[key] = id;
        emit NameSet(id, name);
    }

    // ---- sigillo ---------------------------------------------------------

    /// @notice Per sempre. Nessuno scrivera' piu' su questa card, nemmeno chi la possiede.
    function seal(uint256 id) external {
        Card storage c = _requireWritable(id);
        c.locked = true;
        emit Sealed(id, block.number);
    }

    function setLabel(uint256 id, bytes32 label) external {
        Card storage c = _requireWritable(id);
        c.label = label;
        emit LabelSet(id, label);
    }

    // ---- leggere ---------------------------------------------------------

    function card(uint256 id) external view returns (Card memory) {
        if (_cards[id].born == 0) revert NoSuchCard();
        return _cards[id];
    }

    /// @notice `len` byte da `offset`. Gratis, per chiunque.
    function read(uint256 id, uint256 offset, uint256 len) public view returns (bytes memory out) {
        Card storage c = _cards[id];
        if (c.born == 0) revert NoSuchCard();
        Kind storage k = kinds[c.kind];
        if (!k.onchain) revert NotOnChain();
        if (offset + len > k.capacity) revert OutOfBounds();
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            uint256 p = offset + i;
            bytes32 word = _data[id][p / 32];
            out[i] = word[p % 32];
        }
    }

    /// @notice Tutto cio' che e' stato scritto, dall'inizio all'ultimo byte usato.
    function readAll(uint256 id) external view returns (bytes memory) {
        return read(id, 0, _cards[id].used);
    }

    function slotAt(uint256 id, uint256 slot) external view returns (bytes32) { return _data[id][slot]; }
    function contentOf(uint256 id) external view returns (bytes32 contentHash, string memory uri) { return (_contentHash[id], _uri[id]); }
    function nameOf(uint256 id) external view returns (string memory) { return _nameOf[id]; }
    function cardOfName(string calldata name) external view returns (uint256) { return cardByName[keccak256(bytes(name))]; }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return string.concat("data:application/json;base64,", Base64.encode(bytes(_json(id))));
    }

    function _json(uint256 id) internal view returns (string memory) {
        Kind storage k = kinds[_cards[id].kind];
        return string.concat(
            '{"name":"RH-4 Memory Card #', id.toString(), '","description":"',
            k.onchain ? "Memory that lives inside the chain: bytes on-chain, written by its owner, readable by anyone." : "A pointer to content off-chain: hash and URI on-chain, sealable.",
            '",', _attrs(id), ',"image":"data:image/svg+xml;base64,', Base64.encode(bytes(_svg(id))), '"}'
        );
    }

    function _attrs(uint256 id) internal view returns (string memory) {
        Card storage c = _cards[id];
        Kind storage k = kinds[c.kind];
        return string.concat(
            '"attributes":[{"trait_type":"kind","value":"', k.name, '"},{"trait_type":"storage","value":"', k.onchain ? "on-chain" : "pinned",
            '"},{"trait_type":"used","value":', uint256(c.used).toString(), '},{"trait_type":"sealed","value":"', c.locked ? "yes" : "no",
            '"},{"trait_type":"label","value":"', _labelString(c.label), '"}]'
        );
    }

    // ---- interno ---------------------------------------------------------

    function _requireWritable(uint256 id) internal view returns (Card storage c) {
        if (ownerOf(id) != msg.sender) revert NotCardOwner();
        c = _cards[id];
        if (c.locked) revert CardSealed();
    }

    function _labelString(bytes32 raw) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && raw[len] != 0) { unchecked { ++len; } }
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            bytes1 ch = raw[i];
            // niente virgolette o backslash nel JSON: si sostituiscono con uno spazio
            out[i] = (ch == '"' || ch == "\\" || uint8(ch) < 0x20) ? bytes1(" ") : ch;
        }
        return string(out);
    }

    function _svg(uint256 id) internal view returns (string memory) {
        return string.concat(_svgHead(id), _svgBody(id));
    }

    function _svgHead(uint256 id) internal view returns (string memory) {
        Card storage c = _cards[id];
        Kind storage k = kinds[c.kind];
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260"><rect width="400" height="260" rx="18" fill="#0c0d0b"/>',
            '<rect x="24" y="24" width="352" height="212" rx="12" fill="none" stroke="#272a25" stroke-width="2"/>',
            '<text x="40" y="66" font-family="monospace" font-size="22" font-weight="700" fill="#fff">RH-4 MEMORY CARD</text>',
            '<text x="40" y="96" font-family="monospace" font-size="14" fill="#8fe8b0">#', id.toString(), ' \xc2\xb7 ', k.name,
            k.onchain ? " \xc2\xb7 ON-CHAIN" : " \xc2\xb7 PINNED", c.locked ? " \xc2\xb7 SEALED" : "", '</text>'
        );
    }

    function _svgBody(uint256 id) internal view returns (string memory) {
        Card storage c = _cards[id];
        Kind storage k = kinds[c.kind];
        uint256 bar = k.onchain && k.capacity != 0 ? (uint256(c.used) * 320) / k.capacity : 0;
        return string.concat(
            '<text x="40" y="128" font-family="monospace" font-size="14" fill="#6f7669">', _labelString(c.label), '</text>',
            '<rect x="40" y="170" width="320" height="14" fill="#141613" stroke="#272a25"/>',
            '<rect x="40" y="170" width="', bar.toString(), '" height="14" fill="#8fe8b0"/>',
            '<text x="40" y="214" font-family="monospace" font-size="12" fill="#6f7669">', uint256(c.used).toString(), ' bytes used \xc2\xb7 ', uint256(c.writes).toString(), ' writes</text></svg>'
        );
    }
}
