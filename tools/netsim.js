#!/usr/bin/env node
/**
 * netsim.js — simulatore della netlist gate-level.
 *
 *   node tools/netsim.js build/rh4.json build/rom.hex [opzioni]
 *
 *     --cycles N          quanti cicli al massimo (default 500)
 *     --expect a,b,c      la sequenza attesa sulla porta di uscita
 *     --no-halt           fallisce se il processore si ferma
 *     --quiet             non stampare ogni uscita
 *
 * Non e' un giocattolo di verifica: e' il modello di riferimento del
 * contratto. Fa esattamente cio' che fa il Solidity a ogni blocco — legge
 * ROM[pc], valuta i NAND nell'ordine topologico, campiona le D, commuta i
 * flip-flop tutti insieme.
 */

const fs = require("fs");
const { load } = require("./netlist");

function readRom(hexPath) {
  return fs
    .readFileSync(hexPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseInt(l, 16));
}

function makeMachine(net, rom) {
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

  function tick() {
    const pc = readPort("pc_o");
    const word = rom[pc] ?? 0;
    net.ports.instr.forEach((b, i) => bits.set(b, (word >> i) & 1));

    for (const g of net.ordered) {
      bits.set(g.y, 1 - (val(g.a) & val(g.b)));
    }

    // campiono tutte le D prima di commutare: i flop scattano insieme
    const next = net.flops.map((ff) => val(ff.d));
    net.flops.forEach((ff, i) => bits.set(ff.q, next[i]));
    return word;
  }

  return { tick, readPort };
}

function parseArgs(argv) {
  const positional = [];
  const opts = { cycles: 500, expect: null, noHalt: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--cycles":   opts.cycles = Number(argv[++i]); break;
      case "--expect":   opts.expect = argv[++i].split(",").map(Number); break;
      case "--no-halt":  opts.noHalt = true; break;
      case "--quiet":    opts.quiet = true; break;
      default:           positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [jsonPath = "build/rh4.json", romPath = "build/rom.hex"] = positional;

  const net = load(jsonPath, "rh4");
  const rom = readRom(romPath);
  const m = makeMachine(net, rom);

  console.log(`netlist: ${net.gates.length} NAND, ${net.flops.length} flip-flop`);
  console.log(`programma: ${romPath}\n`);

  const outs = [];
  let cycles = 0;
  while (!m.readPort("halt_o") && cycles < opts.cycles) {
    const word = m.tick();
    cycles++;
    if (word >>> 8 === 0xe) {
      const v = m.readPort("out_o");
      outs.push(v);
      if (!opts.quiet) console.log(`  ciclo ${String(cycles).padStart(4)}   OUT = ${v}`);
    }
  }

  const halted = m.readPort("halt_o") === 1;
  const problems = [];

  if (opts.noHalt && halted) {
    problems.push(`il processore si e' fermato al ciclo ${cycles}`);
  }
  if (opts.expect) {
    if (!halted && cycles >= opts.cycles) problems.push("nessun halt entro il limite di cicli");
    if (outs.length !== opts.expect.length || outs.some((v, i) => v !== opts.expect[i])) {
      problems.push(`atteso [${opts.expect}], ottenuto [${outs}]`);
    }
  }

  console.log();
  if (problems.length) {
    for (const p of problems) console.log(`FALLITO  ${p}`);
    process.exit(1);
  }

  console.log(
    halted
      ? `OK  halt al ciclo ${cycles}, ${outs.length} uscite`
      : `OK  ${cycles} cicli senza mai fermarsi, ${outs.length} uscite`
  );
  console.log(
    `    a 10 Hz (block time Robinhood Chain) sono ${(cycles / 10).toFixed(1)} s di esecuzione`
  );
}

main();
