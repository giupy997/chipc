#!/usr/bin/env node
/**
 * codegen8.js — netlist yosys -> interprete Solidity/Yul.
 *
 *   node tools/codegen8.js build/rh8.json src/RH8Gates.sol
 *
 * ---------------------------------------------------------------------------
 *  Perche' interpretare invece di srotolare
 * ---------------------------------------------------------------------------
 * La RH-4 emetteva una riga di Yul per porta. Con 2.368 porte quella strada
 * fa ~32 kB di bytecode contro un limite di 24. Qui i gate diventano dati e
 * il contratto li scorre: 14 kB di tabella e un ciclo di poche istruzioni.
 *
 * Si paga in gas — circa tre volte — e si compra l'assenza di un tetto:
 * questo interprete regge una netlist di qualunque dimensione.
 *
 * ---------------------------------------------------------------------------
 *  Le due scelte che tolgono lavoro al ciclo interno
 * ---------------------------------------------------------------------------
 * 1. L'uscita di un gate non viene memorizzata. Assegnando gli slot in
 *    ordine topologico, il gate i-esimo scrive sempre nello slot successivo
 *    al precedente: basta un puntatore che avanza di 32.
 *
 * 2. Gli ingressi sono gia' scritti come SCOSTAMENTI in byte, non come
 *    indici. Cosi' non serve moltiplicare per 32 dentro il ciclo, che su
 *    2.368 iterazioni sarebbero 24.000 gas di sole moltiplicazioni.
 *
 * Il risultato e' un ciclo senza una sola MUL.
 */

const fs = require("fs");
const path = require("path");
const { load, CONST_BITS } = require("./netlist");

// Un net vale 0 o 1: tenerlo in una parola da 32 byte costava 27.000 gas
// di sola espansione di memoria. Un byte basta, e come effetto gli
// scostamenti scendono a 16 bit — otto porte per MLOAD invece di cinque.
const WORD = 1;
const GATE_BYTES = 4; // due scostamenti da 16 bit
const PER_ITER = 8;   // 8 x 4 = 32 byte, una parola esatta
const WORD_BYTES = 32;

function generate(net, topName, jsonPath) {
  // netlist.js espone le porte come soli array di bit: la direzione la sa
  // solo il JSON grezzo, e senza quella il filtro sugli ingressi non
  // aggancerebbe niente — in silenzio.
  const design = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const rawPorts = design.modules[topName.toLowerCase()].ports;

  // --- assegnazione degli slot ---------------------------------------------
  // L'ordine non e' estetico: i gate DEVONO stare in fondo e in ordine
  // topologico, perche' e' quello che rende implicito l'indice di uscita.
  const slot = new Map();
  const take = (bit) => {
    if (CONST_BITS.has(String(bit))) return;
    if (!slot.has(bit)) slot.set(bit, slot.size);
  };

  const inputPorts = Object.entries(rawPorts)
    .filter(([name, p]) => p.direction === "input" && name !== "clk");
  if (inputPorts.length === 0) throw new Error("nessuna porta di ingresso trovata");
  for (const [, p] of inputPorts) for (const b of p.bits) take(b);

  const firstFlop = slot.size;
  for (const ff of net.flops) take(ff.q);

  const firstGate = slot.size;
  for (const g of net.ordered) take(g.y);

  const ZERO = slot.size;
  const ONE = slot.size + 1;
  const nets = slot.size + 2;

  // controllo che la promessa regga: gli slot dei gate devono essere
  // esattamente consecutivi, altrimenti il puntatore che avanza non funziona
  net.ordered.forEach((g, i) => {
    if (slot.get(g.y) !== firstGate + i) {
      throw new Error(`slot dei gate non consecutivi al gate ${i}`);
    }
  });

  // `bytes memory table = TABLE` e' la prima allocazione della funzione,
  // quindi cade sempre a 0x80 con i dati a 0xA0. I net vengono subito dopo,
  // a un indirizzo che si conosce gia' qui — e allora tanto vale scrivere
  // negli scostamenti l'indirizzo ASSOLUTO, invece di sommare `base` a ogni
  // operando dentro il ciclo. Sono 12 gas per porta, 28.000 in tutto.
  const tableLen = net.gates.length * GATE_BYTES + WORD_BYTES;
  const NETS_BASE = 0xa0 + Math.ceil(tableLen / 32) * 32;

  const offsetOf = (bit) => {
    const s = String(bit);
    if (s === "1") return NETS_BASE + ONE * WORD;
    if (CONST_BITS.has(s)) return NETS_BASE + ZERO * WORD;
    return NETS_BASE + slot.get(bit) * WORD;
  };

  // --- la tabella dei gate --------------------------------------------------
  const bytes = [];
  const push16 = (v) => {
    if (v > 0xffff) throw new Error(`scostamento oltre i 16 bit: ${v}`);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  };
  for (const g of net.ordered) {
    push16(offsetOf(g.a));
    push16(offsetOf(g.b));
  }
  // Il ciclo legge 32 byte alla volta ma ne consuma 6: senza questa coda
  // l'ultima lettura sconfinerebbe oltre i dati.
  for (let i = 0; i < WORD; i++) bytes.push(0);

  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

  // --- porte di uscita registrate ------------------------------------------
  const flopOf = new Map(net.flops.map((ff, i) => [ff.q, i]));
  const outBits = {};
  for (const [name, p] of Object.entries(rawPorts)) {
    if (p.direction !== "output") continue;
    outBits[name] = p.bits.map((b, i) => {
      const idx = flopOf.get(b);
      if (idx === undefined) throw new Error(`l'uscita ${name}[${i}] non e' registrata`);
      return idx;
    });
  }

  // --- registri, dai nomi che yosys conserva -------------------------------
  const named = design.modules[topName.toLowerCase()].netnames;
  const regBases = [];
  for (let i = 0; i < 16; i++) {
    const e = named[`regs[${i}]`];
    if (!e) throw new Error(`regs[${i}] non rintracciabile`);
    const bits = e.bits.map((b) => flopOf.get(b));
    if (bits.some((b) => b === undefined)) throw new Error(`regs[${i}] non registrato`);
    if (!bits.every((b, k) => b === bits[0] + k)) throw new Error(`regs[${i}] non contigui`);
    regBases.push(bits[0]);
  }
  let regPacked = 0n;
  regBases.forEach((b, i) => { regPacked |= BigInt(b) << BigInt(i * 8); });

  const flagOf = (name) => {
    const e = named[name];
    if (!e) throw new Error(`${name} non rintracciabile`);
    return flopOf.get(e.bits[0]);
  };

  // --- emissione ------------------------------------------------------------
  const L = [];
  const p = (s = "") => L.push(s);
  const hx = (n) => "0x" + n.toString(16);

  p("// SPDX-License-Identifier: MIT");
  p("pragma solidity ^0.8.24;");
  p("");
  p("// ┌───────────────────────────────────────────────────────────────────┐");
  p("// │  GENERATO DA tools/codegen8.js — NON MODIFICARE A MANO.            │");
  p("// │  Sorgente: rtl/rh8.v -> yosys -> build/rh8.json -> questo file.    │");
  p("// └───────────────────────────────────────────────────────────────────┘");
  p("//");
  p(`//  ${net.gates.length} porte NAND, ${net.flops.length} flip-flop D.`);
  p("//  I gate sono dati, non codice: srotolarli sforerebbe i 24 kB.");
  p("");
  p(`contract ${topName}GateArray {`);
  p(`    uint256 public constant GATES = ${net.gates.length};`);
  p(`    uint256 public constant FLOPS = ${net.flops.length};`);
  p("");
  p("    /// @dev Due scostamenti in byte da 24 bit per porta, gia'");
  p("    ///      moltiplicati per 32: nel ciclo non resta una sola MUL.");
  p(`    bytes private constant TABLE = hex"${hex}";`);
  p("");
  p("    /**");
  p("     * @notice Un colpo di clock: un blocco della chain.");
  p("     * @param state   i bit dei flip-flop");
  p("     * @param instr   ROM[pc], gia' letta dal chiamante");
  p("     * @param inPort  il byte passato a tick()");
  p("     * @param ramData RAM[ram_addr], letta dal chiamante");
  p("     */");
  p("    function step(uint256 state, uint256 instr, uint256 inPort, uint256 ramData)");
  p("        external");
  p("        pure");
  p("        returns (uint256 next)");
  p("    {");
  p("        bytes memory table = TABLE;");
  p("        assembly {");
  p("            // i net vivono subito dopo la tabella: una parola ciascuno");
  p("            // Se questa non regge, gli scostamenti puntano nel vuoto.");
  p("            if iszero(eq(table, 0x80)) { revert(0, 0) }");
  p(`            mstore(0x40, ${hx(NETS_BASE + nets * WORD + 32)})`); // +32: mload sconfina
  p(`            mstore8(${hx(NETS_BASE + ONE * WORD)}, 1)`);
  p("");

  // ingressi
  p("            // --- ingressi ---");
  for (const [name, port] of inputPorts) {
    const src = { instr: "instr", in_port: "inPort", ram_rdata: "ramData" }[name];
    if (!src) throw new Error(`ingresso non previsto: ${name}`);
    port.bits.forEach((bit, i) => {
      const shifted = i === 0 ? src : `shr(${i}, ${src})`;
      p(`            mstore8(${hx(offsetOf(bit))}, and(${shifted}, 1))`);
    });
  }
  p("");
  p("            // --- uscite dei flip-flop ---");
  net.flops.forEach((ff, i) => {
    const shifted = i === 0 ? "state" : `shr(${i}, state)`;
    p(`            mstore8(${hx(offsetOf(ff.q))}, and(${shifted}, 1))`);
  });
  p("");
  // --- il ciclo, srotolato a gruppi ---------------------------------------
  // Una porta per giro costava piu' in gestione del salto che in lavoro.
  // Otto per giro ammortizzano quel costo ed entrano in una MLOAD esatta.
  //
  // Il valore di un net e' il byte PIU' SIGNIFICATIVO di mload(indirizzo):
  // per questo l'AND fra i due si maschera in cima invece di spostarli in
  // basso. Una maschera costa meno di due shift.
  const TOP = "0xff00000000000000000000000000000000000000000000000000000000000000";
  const groups = Math.floor(net.gates.length / PER_ITER);
  const tail = net.gates.length - groups * PER_ITER;

  const emitGate = (k, indent) => {
    const sa = 240 - 32 * k;
    const sb = 224 - 32 * k;
    const A = sa === 240 ? `shr(${sa}, w)` : `and(shr(${sa}, w), 0xffff)`;
    const B = sb === 0 ? `and(w, 0xffff)` : `and(shr(${sb}, w), 0xffff)`;
    p(`${indent}mstore8(y, iszero(and(and(mload(${A}), mload(${B})), ${TOP})))`);
    p(`${indent}y := add(y, 1)`);
  };

  p(`            // --- ${net.gates.length} NAND, dalla tabella ---`);
  p("            let p := add(table, 32)");
  p(`            let y := ${hx(NETS_BASE + firstGate * WORD)}`);
  if (groups > 0) {
    p(`            let last := add(p, ${groups * PER_ITER * GATE_BYTES})`);
    p("            for { } lt(p, last) { } {");
    p("                let w := mload(p)");
    for (let k = 0; k < PER_ITER; k++) emitGate(k, "                ");
    p(`                p := add(p, ${PER_ITER * GATE_BYTES})`);
    p("            }");
  }
  if (tail > 0) {
    p(`            // le ultime ${tail}, fuori dal ciclo`);
    p("            {");
    p("                let w := mload(p)");
    for (let k = 0; k < tail; k++) emitGate(k, "                ");
    p("            }");
  }
  p("");
  p("            // --- fronte di salita ---");
  net.flops.forEach((ff, i) => {
    const off = offsetOf(ff.d);
    if (off === NETS_BASE + ZERO * WORD && String(ff.d) !== "1") return; // resta a zero
    const read = `shr(248, mload(${hx(off)}))`;
    p(`            next := or(next, ${i === 0 ? read : `shl(${i}, ${read})`})`);
  });
  p("        }");
  p("    }");
  p("}");

  // --- libreria di lettura dello stato --------------------------------------
  const S = [];
  const q = (s = "") => S.push(s);
  q("// SPDX-License-Identifier: MIT");
  q("pragma solidity ^0.8.24;");
  q("");
  q("// GENERATO DA tools/codegen8.js — dove stanno i bit dentro lo stato.");
  q("");
  q(`library ${topName}State {`);
  q(`    uint256 internal constant BITS = ${net.flops.length};`);
  q(`    uint256 internal constant MASK = (uint256(1) << ${net.flops.length}) - 1;`);
  q("");
  const field = (fn, name, sol, doc) => {
    const bits = outBits[name];
    q(`    /// @notice ${doc}`);
    q(`    function ${fn}(uint256 s) internal pure returns (${sol}) {`);
    if (sol === "bool") {
      q(`        return (s >> ${bits[0]}) & 1 == 1;`);
    } else {
      const contiguous = bits.every((b, i) => b === bits[0] + i);
      if (!contiguous) throw new Error(`${name} non contiguo`);
      const mask = (1n << BigInt(bits.length)) - 1n;
      q(`        return ${sol}((s >> ${bits[0]}) & 0x${mask.toString(16)});`);
    }
    q("    }");
    q("");
  };
  field("pc", "pc_o", "uint16", "Program counter, 10 bit.");
  field("out", "out_o", "uint8", "Porta di uscita.");
  field("ramAddr", "ram_addr_o", "uint8", "Indirizzo che il contratto deve leggere.");
  field("ramWdata", "ram_wdata_o", "uint8", "Dato da scrivere in RAM.");
  field("ramWe", "ram_we_o", "bool", "Vero se questo ciclo scrive in RAM.");
  field("halted", "halt_o", "bool", "Vero se il processore ha incontrato HLT.");

  q(`    uint256 internal constant REG_BASES = 0x${regPacked.toString(16)};`);
  q("");
  q("    /// @notice Uno dei sedici registri da 8 bit.");
  q("    function reg(uint256 s, uint256 i) internal pure returns (uint8) {");
  q("        return uint8((s >> ((REG_BASES >> (i * 8)) & 0xff)) & 0xff);");
  q("    }");
  q("");
  q(`    function carry(uint256 s) internal pure returns (bool) { return (s >> ${flagOf("cf")}) & 1 == 1; }`);
  q(`    function zero(uint256 s) internal pure returns (bool) { return (s >> ${flagOf("zf")}) & 1 == 1; }`);
  q("}");

  return {
    code: L.join("\n") + "\n",
    stateCode: S.join("\n") + "\n",
    nets,
    tableBytes: bytes.length,
    outBits,
  };
}

function main() {
  const [jsonPath = "build/rh8.json", outPath = "src/RH8Gates.sol"] = process.argv.slice(2);
  const net = load(jsonPath, "rh8");
  const r = generate(net, "RH8", jsonPath);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, r.code);
  const statePath = path.join(path.dirname(outPath), "RH8State.sol");
  fs.writeFileSync(statePath, r.stateCode);

  console.log(`${outPath}  +  ${statePath}`);
  console.log(`  ${net.gates.length} NAND interpretati, ${net.flops.length} flip-flop`);
  console.log(`  tabella   ${(r.tableBytes / 1024).toFixed(1)} kB`);
  console.log(`  net       ${r.nets} parole di memoria`);
  for (const [n, b] of Object.entries(r.outBits)) {
    console.log(`  ${n} -> bit ${b.length === 1 ? b[0] : `${b[0]}..${b[b.length - 1]}`}`);
  }
}

main();
