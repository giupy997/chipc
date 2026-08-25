// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RH4State} from "./RH4State.sol";

interface IRH4GateArray {
    function step(uint256 state, uint256 instr) external pure returns (uint256);
    function run(uint256 state, uint256[16] calldata rom, uint256 maxCycles)
        external pure returns (uint256 finalState, uint256 executed);
}

interface IChipRenderer {
    function tokenURI(uint256 id, ChipFactory.Chip calldata chip, uint256[16] calldata rom)
        external view returns (string memory);
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
 */
contract ChipFactory is ERC721, Ownable {
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
        bytes32 label;     // nome, fino a 32 caratteri
        address minter;    // chi l'ha coniato: non cambia mai
        uint64 bornBlock;  // 0 = il chip non esiste
        uint32 resets;
    }

    IRH4GateArray public immutable gates;

    mapping(uint256 => Chip) private _chips;
    mapping(uint256 => uint256[ROM_SLOTS]) private _rom;

    uint256 public totalChips;
    uint256 public mintPrice;
    IChipRenderer public renderer;

    event ChipMinted(
        uint256 indexed id,
        address indexed minter,
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
    event Output(uint256 indexed id, uint256 indexed cycle, uint8 value);
    event Halt(uint256 indexed id, uint256 indexed cycle);
    event Reprogrammed(uint256 indexed id, bytes32 programHash);
    event Restarted(uint256 indexed id, uint256 atCycle);

    error NoSuchChip();
    error OneTickPerBlock();
    error AlreadyHalted();
    error NotChipOwner();
    error WrongPayment();

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
    function mint(uint256[ROM_SLOTS] calldata words, bytes32 label)
        external
        payable
        returns (uint256 id)
    {
        if (msg.value != mintPrice) revert WrongPayment();

        unchecked { id = ++totalChips; }

        Chip storage c = _chips[id];
        c.label = label;
        c.minter = msg.sender;
        c.bornBlock = uint64(block.number);

        // scrivo solo le parole non nulle: una ROM da 42 istruzioni ne
        // occupa tre su sedici, e uno SSTORE a zero e' 20.000 gas buttati
        uint256[ROM_SLOTS] storage rom = _rom[id];
        for (uint256 i; i < ROM_SLOTS; ++i) {
            if (words[i] != 0) rom[i] = words[i];
        }

        _safeMint(msg.sender, id);
        emit ChipMinted(id, msg.sender, label, keccak256(abi.encode(words)));
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
            : renderer.tokenURI(id, _chips[id], _rom[id]);
    }

    // ---- amministrazione ---------------------------------------------------

    function setRenderer(IChipRenderer r) external onlyOwner { renderer = r; }
    function setMintPrice(uint256 p) external onlyOwner { mintPrice = p; }

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

    function _requireChipOwner(uint256 id) internal view {
        if (_ownerOf(id) != msg.sender) revert NotChipOwner();
    }
}
