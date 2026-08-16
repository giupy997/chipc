/**
 * netlist.js — carica la netlist JSON di yosys e la mette in una forma
 * pronta all'uso: gate NAND gia' ordinati topologicamente, flip-flop
 * separati, mappa dei bit di ingresso/uscita.
 *
 * Lo stesso ordinamento che serve al simulatore JS servira' al codegen Yul:
 * dentro l'EVM non c'e' propagazione, c'e' una sequenza di istruzioni, e
 * l'ordine deve essere quello.
 */

const fs = require("fs");

const CONST_BITS = new Set(["0", "1", "x", "z"]);

function load(jsonPath, topName) {
  const design = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const top = design.modules[topName];
  if (!top) throw new Error(`modulo "${topName}" non trovato in ${jsonPath}`);

  const gates = [];   // { a, b, y }
  const flops = [];   // { d, q, init }
  const driver = new Map(); // bit -> indice del gate che lo pilota

  for (const [name, cell] of Object.entries(top.cells)) {
    const c = cell.connections;
    if (cell.type === "$_NAND_") {
      const y = c.Y[0];
      driver.set(y, gates.length);
      gates.push({ a: c.A[0], b: c.B[0], y, name });
    } else if (cell.type === "$_DFF_P_") {
      flops.push({ d: c.D[0], q: c.Q[0], init: 0, name });
    } else {
      throw new Error(`cella non prevista "${cell.type}" (${name})`);
    }
  }

  // valori iniziali dei flip-flop, presi dagli attributi init delle net
  const initByBit = new Map();
  for (const net of Object.values(top.netnames)) {
    const init = net.attributes && net.attributes.init;
    if (init === undefined) continue;
    // yosys scrive la stringa col bit piu' significativo per primo
    const bits = String(init).split("").reverse();
    net.bits.forEach((bit, i) => {
      if (!CONST_BITS.has(String(bit)) && bits[i] !== undefined) {
        initByBit.set(bit, bits[i] === "1" ? 1 : 0);
      }
    });
  }
  for (const ff of flops) ff.init = initByBit.get(ff.q) ?? 0;

  // Ordinamento topologico dei NAND. Le uscite dei flip-flop e gli ingressi
  // del modulo sono foglie: nel ciclo corrente sono valori gia' noti.
  const known = new Set();
  for (const ff of flops) known.add(ff.q);
  for (const p of Object.values(top.ports)) {
    if (p.direction === "input") for (const b of p.bits) known.add(b);
  }

  const order = [];
  const state = new Uint8Array(gates.length); // 0 mai visto, 1 in corso, 2 fatto
  for (let root = 0; root < gates.length; root++) {
    if (state[root] === 2) continue;
    const stack = [[root, false]];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const [gi, expanded] = frame;
      if (state[gi] === 2) { stack.pop(); continue; }
      if (expanded) {
        state[gi] = 2;
        order.push(gi);
        stack.pop();
        continue;
      }
      if (state[gi] === 1) {
        throw new Error(`anello combinatorio sul gate ${gates[gi].name}`);
      }
      state[gi] = 1;
      frame[1] = true;
      for (const src of [gates[gi].a, gates[gi].b]) {
        if (CONST_BITS.has(String(src)) || known.has(src)) continue;
        const d = driver.get(src);
        if (d === undefined) throw new Error(`bit ${src} senza driver`);
        if (state[d] !== 2) stack.push([d, false]);
      }
    }
  }

  const portBits = {};
  for (const [name, p] of Object.entries(top.ports)) portBits[name] = p.bits;

  return {
    gates,
    flops,
    order,               // indici in `gates`, in ordine di valutazione
    ordered: order.map((i) => gates[i]),
    ports: portBits,
    driver,
  };
}

module.exports = { load, CONST_BITS };
