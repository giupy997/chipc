#!/usr/bin/env node
/**
 * webgen.js — impacchetta la netlist e i programmi per il sito.
 *
 *   node tools/webgen.js docs/rh4-data.js
 *
 * Il sito non e' un video del processore: e' il processore. La stessa netlist
 * che gira dentro l'EVM gira nel browser di chi guarda, gate per gate. Per
 * questo qui non si esporta un filmato ma la lista dei NAND.
 *
 * Formato compatto: i net diventano indici densi e le costanti diventano due
 * net finti in fondo all'array (uno sempre 0, uno sempre 1). Cosi' il ciclo
 * di simulazione non ha un solo ramo condizionale.
 */

const fs = require("fs");
const path = require("path");
const { load, CONST_BITS } = require("./netlist");

const PROGRAMS = ["forever", "fib"];

function packNetlist(net) {
  const index = new Map();
  const idx = (bit) => {
    if (!index.has(bit)) index.set(bit, index.size);
    return index.get(bit);
  };

  // stesso ordine di allocazione del codegen Solidity, cosi' i due mondi
  // restano confrontabili quando si va a caccia di differenze
  for (const b of net.ports.instr) idx(b);
  for (const ff of net.flops) idx(ff.q);
  for (const g of net.gates) idx(g.y);

  const NETS = index.size;
  const ZERO = NETS;
  const ONE = NETS + 1;

  const ref = (bit) => {
    const s = String(bit);
    if (s === "1") return ONE;
    if (CONST_BITS.has(s)) return ZERO;
    return idx(bit);
  };

  // i gate escono gia' in ordine topologico: nel browser come nell'EVM non
  // c'e' propagazione, c'e' una sequenza
  const gates = [];
  for (const g of net.ordered) gates.push(ref(g.a), ref(g.b), idx(g.y));

  const flops = [];
  for (const ff of net.flops) flops.push(ref(ff.d), idx(ff.q));

  const flopOf = new Map(net.flops.map((ff, i) => [ff.q, i]));

  // Yosys conserva i nomi RTL delle net: da li' si ricava quale flip-flop e'
  // quale registro, senza dover aggiungere porte di debug al processore.
  const design = JSON.parse(fs.readFileSync("build/rh4.json", "utf8"));
  const named = design.modules.rh4.netnames;
  const flopsNamed = (name) => {
    const entry = named[name];
    if (!entry) return null;
    const bits = entry.bits.map((b) => flopOf.get(b));
    return bits.every((b) => b !== undefined) ? bits : null;
  };

  const regs = [];
  for (let i = 0; i < 16; i++) {
    const bits = flopsNamed(`regs[${i}]`);
    if (!bits) throw new Error(`regs[${i}] non rintracciabile nella netlist`);
    regs.push(bits);
  }

  const cf = flopsNamed("cf");
  const zf = flopsNamed("zf");
  if (!cf || !zf) throw new Error("flag cf/zf non rintracciabili nella netlist");

  return {
    regs,
    cf: cf[0],
    zf: zf[0],
    nets: NETS + 2,
    zero: ZERO,
    one: ONE,
    gateCount: net.gates.length,
    flopCount: net.flops.length,
    gates,
    flops,
    instr: net.ports.instr.map(idx),
    pc: net.ports.pc_o.map((b) => flopOf.get(b)),
    out: net.ports.out_o.map((b) => flopOf.get(b)),
    halt: flopOf.get(net.ports.halt_o[0]),
  };
}

function loadProgram(name) {
  const hex = fs
    .readFileSync(`build/${name}.hex`, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseInt(l, 16));
  const meta = JSON.parse(fs.readFileSync(`build/${name}.json`, "utf8"));
  return {
    rom: hex,
    labels: meta.labels,
    listing: meta.listing.map((i) => ({ pc: i.pc, hex: i.hex, src: i.src })),
  };
}

function main() {
  const outPath = process.argv[2] || "docs/rh4-data.js";
  const net = load("build/rh4.json", "rh4");
  const packed = packNetlist(net);

  const programs = {};
  for (const name of PROGRAMS) programs[name] = loadProgram(name);

  const payload = { ...packed, programs };
  const body =
    "// GENERATO DA tools/webgen.js — non modificare a mano.\n" +
    "// La netlist della RH-4: gli stessi 1.029 NAND che girano dentro l'EVM.\n" +
    "window.RH4_DATA = " +
    JSON.stringify(payload) +
    ";\n";

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);

  console.log(`${outPath}`);
  console.log(`  ${packed.gateCount} NAND, ${packed.flopCount} flip-flop, ${packed.nets} net`);
  console.log(`  programmi: ${PROGRAMS.join(", ")}`);
  console.log(`  ${(body.length / 1024).toFixed(1)} kB`);
}

main();
