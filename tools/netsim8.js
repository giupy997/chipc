#!/usr/bin/env node
/**
 * netsim8.js — simulatore gate-level della RH-8.
 *
 *   node tools/netsim8.js build/rh8.json build/echo8.hex8 [opzioni]
 *
 *     --cycles N       quanti cicli (default 500)
 *     --inputs a,b,c   la sequenza di byte in ingresso, ripetuta in ciclo
 *     --expect a,b,c   la sequenza attesa sulla porta di uscita
 *     --no-halt        fallisce se il processore si ferma
 *     --quiet          non stampare ogni uscita
 *
 * Fa esattamente cio' che fa il contratto a ogni blocco, nello stesso
 * ordine: legge ROM[pc] e RAM[indirizzo latchato], valuta i NAND, commuta i
 * flip-flop insieme, e SE il nuovo stato alza ram_we scrive in RAM.
 */

const fs = require("fs");
const { load } = require("./netlist");

function readRom(hexPath) {
  return fs.readFileSync(hexPath, "utf8")
    .split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => parseInt(l, 16));
}

function parseArgs(argv) {
  const positional = [];
  const opts = { cycles: 500, inputs: [0], expect: null, noHalt: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--cycles": opts.cycles = Number(argv[++i]); break;
      case "--inputs": opts.inputs = argv[++i].split(",").map(Number); break;
      case "--expect": opts.expect = argv[++i].split(",").map(Number); break;
      case "--no-halt": opts.noHalt = true; break;
      case "--quiet": opts.quiet = true; break;
      default: positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [jsonPath = "build/rh8.json", romPath = "build/echo8.hex8"] = positional;

  const net = load(jsonPath, "rh8");
  const rom = readRom(romPath);
  const ram = new Uint8Array(256);

  const bits = new Map();
  for (const ff of net.flops) bits.set(ff.q, ff.init);
  const val = (b) => {
    const s = String(b);
    if (s === "0") return 0;
    if (s === "1") return 1;
    if (s === "x" || s === "z") return 0;
    return bits.get(b) ?? 0;
  };
  const readPort = (name) =>
    net.ports[name].reduce((acc, b, i) => acc | (val(b) << i), 0);
  const writePort = (name, v) =>
    net.ports[name].forEach((b, i) => bits.set(b, (v >> i) & 1));

  function tick(inPort) {
    const word = rom[readPort("pc_o")] ?? 0;
    writePort("instr", word);
    writePort("in_port", inPort);
    // l'indirizzo e' quello latchato dal ciclo scorso: la load a due cicli
    writePort("ram_rdata", ram[readPort("ram_addr_o")]);

    for (const g of net.ordered) bits.set(g.y, 1 - (val(g.a) & val(g.b)));

    const next = net.flops.map((ff) => val(ff.d));
    net.flops.forEach((ff, i) => bits.set(ff.q, next[i]));

    if (readPort("ram_we_o")) ram[readPort("ram_addr_o")] = readPort("ram_wdata_o");
    return word;
  }

  console.log(`netlist: ${net.gates.length} NAND, ${net.flops.length} flip-flop`);
  console.log(`programma: ${romPath}, ingressi: [${opts.inputs}]\n`);

  const outs = [];
  let cycles = 0;
  while (!readPort("halt_o") && cycles < opts.cycles) {
    const word = tick(opts.inputs[cycles % opts.inputs.length] & 0xff);
    cycles++;
    if (word >>> 20 === 22) {
      const v = readPort("out_o");
      outs.push(v);
      if (!opts.quiet) console.log(`  ciclo ${String(cycles).padStart(5)}   OUT = ${v}`);
    }
  }

  const halted = readPort("halt_o") === 1;
  const problems = [];
  if (opts.noHalt && halted) problems.push(`il processore si e' fermato al ciclo ${cycles}`);
  if (opts.expect) {
    const got = outs.slice(0, opts.expect.length);
    if (got.length !== opts.expect.length || got.some((v, i) => v !== opts.expect[i])) {
      problems.push(`atteso [${opts.expect}], ottenuto [${got}]`);
    }
  }

  console.log();
  if (problems.length) {
    for (const p of problems) console.log(`FALLITO  ${p}`);
    process.exit(1);
  }
  console.log(halted
    ? `OK  halt al ciclo ${cycles}, ${outs.length} uscite`
    : `OK  ${cycles} cicli senza mai fermarsi, ${outs.length} uscite`);
  console.log(`    RAM[0x10] = ${ram[0x10]}`);
}

main();
