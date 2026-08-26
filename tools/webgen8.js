#!/usr/bin/env node
/**
 * webgen8.js — impacchetta la netlist RH-8 e i programmi per il sito.
 *
 *   node tools/webgen8.js docs/rh8-data.js
 *
 * Il sito non e' un video del processore: e' il processore. La stessa
 * netlist che il contratto interpreta gira nel browser di chi guarda, gate
 * per gate, con la sua RAM e il suo ingresso.
 */

const fs = require("fs");
const path = require("path");
const { load, CONST_BITS } = require("./netlist");

const PROGRAMS = ["echo8", "test8"];

function packNetlist(net, jsonPath) {
  const index = new Map();
  const idx = (bit) => {
    if (!index.has(bit)) index.set(bit, index.size);
    return index.get(bit);
  };

  const design = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const rawPorts = design.modules.rh8.ports;

  for (const [name, p] of Object.entries(rawPorts)) {
    if (p.direction === "input" && name !== "clk") for (const b of p.bits) idx(b);
  }
  for (const ff of net.flops) idx(ff.q);
  for (const g of net.gates) idx(g.y);

  const NETS = index.size;
  const ZERO = NETS, ONE = NETS + 1;
  const ref = (bit) => {
    const s = String(bit);
    if (s === "1") return ONE;
    if (CONST_BITS.has(s)) return ZERO;
    return idx(bit);
  };

  const gates = [];
  for (const g of net.ordered) gates.push(ref(g.a), ref(g.b), idx(g.y));
  const flops = [];
  for (const ff of net.flops) flops.push(ref(ff.d), idx(ff.q));

  const flopOf = new Map(net.flops.map((ff, i) => [ff.q, i]));
  const outPort = (name) => rawPorts[name].bits.map((b) => flopOf.get(b));

  const named = design.modules.rh8.netnames;
  const regs = [];
  for (let i = 0; i < 16; i++) {
    const bits = named[`regs[${i}]`].bits.map((b) => flopOf.get(b));
    if (bits.some((b) => b === undefined)) throw new Error(`regs[${i}] non registrato`);
    regs.push(bits);
  }

  return {
    nets: NETS + 2, zero: ZERO, one: ONE,
    gateCount: net.gates.length, flopCount: net.flops.length,
    gates, flops,
    instr: rawPorts.instr.bits.map(idx),
    inPort: rawPorts.in_port.bits.map(idx),
    ramRdata: rawPorts.ram_rdata.bits.map(idx),
    pc: outPort("pc_o"), out: outPort("out_o"),
    ramAddr: outPort("ram_addr_o"), ramWdata: outPort("ram_wdata_o"),
    ramWe: outPort("ram_we_o")[0], halt: outPort("halt_o")[0],
    regs,
    cf: flopOf.get(named.cf.bits[0]),
    zf: flopOf.get(named.zf.bits[0]),
  };
}

function loadProgram(name) {
  const hex = fs.readFileSync(`build/${name}.hex8`, "utf8")
    .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => parseInt(l, 16));
  const meta = JSON.parse(fs.readFileSync(`build/${name}.json`, "utf8"));
  return {
    rom: hex,
    labels: meta.labels,
    listing: meta.listing.map((i) => ({ pc: i.pc, hex: i.hex, src: i.src })),
  };
}

function main() {
  const outPath = process.argv[2] || "docs/rh8-data.js";
  const jsonPath = "build/rh8.json";
  const net = load(jsonPath, "rh8");
  const packed = packNetlist(net, jsonPath);

  const programs = {};
  for (const name of PROGRAMS) programs[name] = loadProgram(name);

  const body =
    "// GENERATO DA tools/webgen8.js — non modificare a mano.\n" +
    "// La netlist della RH-8: gli stessi 2.368 NAND che il contratto interpreta.\n" +
    "window.RH8_DATA = " + JSON.stringify({ ...packed, programs }) + ";\n";

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);

  console.log(`${outPath}`);
  console.log(`  ${packed.gateCount} NAND, ${packed.flopCount} flip-flop, ${packed.nets} net`);
  console.log(`  programmi: ${PROGRAMS.join(", ")}  |  ${(body.length / 1024).toFixed(1)} kB`);
}

main();
