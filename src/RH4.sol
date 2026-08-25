// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RH4Gates} from "./RH4Gates.sol";
import {RH4State} from "./RH4State.sol";

/**
 * @title RH-4 — un processore 4-bit che gira dentro la Robinhood Chain
 *
 * Non e' un emulatore. A ogni `tick()` il contratto valuta una per una le
 * 1.029 porte NAND in cui yosys ha sintetizzato il processore, poi fa
 * commutare gli 79 flip-flop tutti insieme. Il codice dei gate sta in
 * RH4Gates.sol ed e' generato dalla netlist, non scritto a mano.
 *
 * Il clock non e' un oscillatore: e' la chain. Un blocco, un colpo di clock.
 * Con i ~100 ms di block time della Robinhood Chain il processore gira a
 * circa 10 Hz.
 *
 * Nessuno possiede il clock. `tick()` e' aperto a chiunque, e chi lo chiama
 * paga il gas di quel ciclo e resta scritto nell'evento come suo sponsor.
 */
contract RH4 {
    // ---- disposizione della parola macchina -------------------------------
    // Tutto lo stato architetturale entra in uno slot solo, ed e' il motivo
    // per cui un ciclo costa poco nonostante le mille porte da valutare.
    //
    //   bit   0..78   stato dei flip-flop (register file, pc, flag, uscita)
    //   bit  80..127  numero di cicli eseguiti
    //   bit 128..175  blocco dell'ultimo tick
    uint256 private constant STATE_MASK = (uint256(1) << 79) - 1;
    uint256 private constant MASK48 = (uint256(1) << 48) - 1;
    uint256 private constant SHIFT_CYCLES = 80;
    uint256 private constant SHIFT_BLOCK = 128;

    uint256 private constant OP_OUT = 0xe;

    /// ROM da 256 parole. Sedici istruzioni da 16 bit per slot (ne servono
    /// 12): sprecare 4 bit vale l'assenza di parole a cavallo di due slot.
    uint256 private constant ROM_SLOTS = 16;

    uint256 private _machine;
    uint256[ROM_SLOTS] private _rom;

    address public immutable operator;
    uint256 public immutable bootBlock;

    /// @notice Un ciclo di clock e' stato eseguito.
    event Cycle(
        uint256 indexed cycle,
        address indexed sponsor,
        uint8 pc,
        uint16 instr,
        uint8 out,
        bool halted
    );
    /// @notice Il programma ha scritto sulla porta di uscita.
    event Output(uint256 indexed cycle, uint8 value);
    /// @notice Il processore ha incontrato HLT.
    event Halt(uint256 indexed cycle);
    /// @notice E' stato caricato un nuovo programma in ROM.
    event Program(bytes32 indexed digest);

    error NotOperator();
    error OneTickPerBlock();
    error AlreadyHalted();
    error BadProgram();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(uint256[ROM_SLOTS] memory program) {
        operator = msg.sender;
        bootBlock = block.number;
        _rom = program;
        emit Program(keccak256(abi.encode(program)));
    }

    // ---- il clock ---------------------------------------------------------

    /**
     * @notice Avanza il processore di un ciclo. Chiamabile da chiunque, una
     *         volta per blocco. Chi paga il gas resta scritto nell'evento.
     */
    function tick() external returns (uint8 pc_, uint8 out_, bool halted_) {
        uint256 m = _machine;
        if (block.number <= m >> SHIFT_BLOCK) revert OneTickPerBlock();

        uint256 state = m & STATE_MASK;
        if (RH4State.halted(state)) revert AlreadyHalted();

        uint8 pc = RH4State.pc(state);
        uint256 instr = _fetch(pc);

        uint256 next = RH4Gates.step(state, instr);
        uint256 cycle = ((m >> SHIFT_CYCLES) & MASK48) + 1;

        _machine =
            next |
            (cycle << SHIFT_CYCLES) |
            (block.number << SHIFT_BLOCK);

        pc_ = RH4State.pc(next);
        out_ = RH4State.out(next);
        halted_ = RH4State.halted(next);

        // _fetch maschera a 12 bit: il cast a uint16 non puo' troncare
        // forge-lint: disable-next-line(unsafe-typecast)
        emit Cycle(cycle, msg.sender, pc_, uint16(instr), out_, halted_);
        if (instr >> 8 == OP_OUT) emit Output(cycle, out_);
        if (halted_) emit Halt(cycle);
    }

    // ---- lettura ----------------------------------------------------------

    /// @notice Program counter, porta di uscita, halt e conteggio dei cicli.
    function inspect()
        external
        view
        returns (uint8 pc, uint8 out, bool halted, uint256 cycles, uint256 lastTickBlock)
    {
        uint256 m = _machine;
        uint256 state = m & STATE_MASK;
        return (
            RH4State.pc(state),
            RH4State.out(state),
            RH4State.halted(state),
            (m >> SHIFT_CYCLES) & MASK48,
            m >> SHIFT_BLOCK
        );
    }

    /// @notice I 79 bit grezzi dei flip-flop. Serve al frontend per disegnare
    ///         i registri senza doverli esporre uno per uno.
    function state() external view returns (uint256) {
        return _machine & STATE_MASK;
    }

    /// @notice Istruzione all'indirizzo `pc`.
    function romAt(uint8 pc) external view returns (uint16) {
        return uint16(_fetch(pc));
    }

    /// @notice Il programma completo, cosi' com'e' impacchettato in storage.
    function program() external view returns (uint256[ROM_SLOTS] memory) {
        return _rom;
    }

    /**
     * @notice Esegue `n` cicli senza toccare lo stato: e' una `view`, si paga
     *         solo se la si chiama da un altro contratto. Il frontend la usa
     *         per mostrare dove andra' a finire il processore.
     */
    function preview(uint256 n)
        external
        view
        returns (uint8 pc, uint8 out, bool halted, uint256 executed)
    {
        uint256 s = _machine & STATE_MASK;
        while (executed < n && !RH4State.halted(s)) {
            s = RH4Gates.step(s, _fetch(RH4State.pc(s)));
            unchecked {
                ++executed;
            }
        }
        return (RH4State.pc(s), RH4State.out(s), RH4State.halted(s), executed);
    }

    // ---- programma --------------------------------------------------------

    /**
     * @notice Carica un nuovo programma e riporta il processore allo zero.
     *         La ROM sta fuori dalla netlist proprio per questo: si cambia
     *         il software senza risintetizzare l'hardware.
     */
    function load(uint256[ROM_SLOTS] calldata words) external onlyOperator {
        for (uint256 i; i < ROM_SLOTS; ++i) _rom[i] = words[i];
        _machine = 0;
        emit Program(keccak256(abi.encode(words)));
    }

    /// @notice Riporta il processore allo stato iniziale, ROM invariata.
    function reset() external onlyOperator {
        _machine = 0;
    }

    // ---- interno ----------------------------------------------------------

    function _fetch(uint8 pc) internal view returns (uint256) {
        unchecked {
            return (_rom[pc >> 4] >> ((pc & 15) * 16)) & 0xfff;
        }
    }
}
