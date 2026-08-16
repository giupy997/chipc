#!/usr/bin/env node
/**
 * codegen.js — netlist yosys -> libreria Solidity/Yul con i gate srotolati.
 *
 *   node tools/codegen.js build/rh4.json src/RH4Gates.sol
 *
 * Il modello di esecuzione dentro l'EVM:
 *
 *   - ogni net vale una parola di memoria da 32 byte, valore 0 o 1.
 *     Sprecone sui bit, ma un mload/mstore costa 3 gas e non serve
 *     nessuno shift per isolare il bit: e' il compromesso giusto.
 *   - i NAND vengono emessi nell'ordine topologico calcolato da netlist.js.
 *     Nell'EVM non c'e' propagazione: c'e' una sequenza, e dev'essere quella.
 *   - i flip-flop non esistono come codice. A inizio ciclo la parola di stato
 *     viene spalmata sui net delle Q, a fine ciclo si ricampionano le D e si
 *     ricompone la parola. Tutti i flop commutano insieme, come nel silicio.
 *
 * Lo stato architetturale del processore sta in 79 bit: una parola sola.
 */

const fs = require("fs");
const path = require("path");
const { load, CONST_BITS } = require("./netlist");

const MEM_BASE = 0x80; // 0x00-0x7f e' area di servizio del compilatore Solidity

function hex(n) {
  return "0x" + n.toString(16);
}

function generate(net, topName) {
  // --- assegnazione delle parole di memoria ---------------------------------
  // Serve un net per ogni uscita di gate, per ogni bit di `instr` e per ogni
  // uscita di flip-flop: sono gli unici valori che qualcuno puo' leggere.
  const slot = new Map();
  const assign = (bit) => {
    if (CONST_BITS.has(String(bit))) return;
    if (!slot.has(bit)) slot.set(bit, MEM_BASE + slot.size * 32);
  };
  for (const b of net.ports.instr) assign(b);
  for (const ff of net.flops) assign(ff.q);
  for (const g of net.gates) assign(g.y);

  const memEnd = MEM_BASE + slot.size * 32;

  // riferimento in lettura: costante letterale oppure parola di memoria
  const ref = (bit) => {
    const s = String(bit);
    if (s === "1") return "1";
    if (s === "0" || s === "x" || s === "z") return "0";
    return `mload(${hex(slot.get(bit))})`;
  };

  // --- le uscite del modulo devono essere registrate ------------------------
  // pc_o, out_o e halt_o escono da flip-flop, quindi si leggono direttamente
  // dalla parola di stato senza rivalutare un solo gate.
  const flopIndexByQ = new Map(net.flops.map((ff, i) => [ff.q, i]));
  const portToStateBits = {};
  for (const [name, bits] of Object.entries(net.ports)) {
    if (name === "clk" || name === "instr") continue;
    portToStateBits[name] = bits.map((b, i) => {
      const idx = flopIndexByQ.get(b);
      if (idx === undefined) {
        throw new Error(
          `l'uscita ${name}[${i}] non e' registrata: non basta la parola di stato`
        );
      }
      return idx;
    });
  }

  // --- emissione ------------------------------------------------------------
  const L = [];
  const p = (s = "") => L.push(s);

  p("// SPDX-License-Identifier: MIT");
  p("pragma solidity ^0.8.24;");
  p("");
  p("// ┌───────────────────────────────────────────────────────────────────┐");
  p("// │  GENERATO DA tools/codegen.js — NON MODIFICARE A MANO.             │");
  p("// │  Sorgente: rtl/rh4.v -> yosys -> build/rh4.json -> questo file.    │");
  p("// │  Per rigenerare: make gates                                        │");
  p("// └───────────────────────────────────────────────────────────────────┘");
  p("//");
  p(`//  ${net.gates.length} porte NAND, ${net.flops.length} flip-flop D.`);
  p("//  Nessuna emulazione: sotto c'e' davvero solo il NAND, ripetuto.");
  p("");
  p(`library ${topName}Gates {`);
  p(`    uint256 internal constant GATES = ${net.gates.length};`);
  p(`    uint256 internal constant FLOPS = ${net.flops.length};`);
  p(`    uint256 internal constant STATE_BITS = ${net.flops.length};`);
  p("");

  // ---- step ----
  p("    /// @notice Un colpo di clock: un blocco della chain.");
  p("    /// @param state parola di stato corrente (i bit dei flip-flop)");
  p("    /// @param instr istruzione gia' letta dalla ROM, 12 bit");
  p("    /// @return next parola di stato dopo il fronte di salita");
  p("    function step(uint256 state, uint256 instr)");
  p("        internal");
  p("        pure");
  p("        returns (uint256 next)");
  p("    {");
  p("        assembly {");
  p("            // riservo l'area dei net e sposto il puntatore di memoria libera");
  p(`            mstore(0x40, ${hex(memEnd)})`);
  p("");
  p("            // --- ingressi: i 12 bit dell'istruzione ---");
  net.ports.instr.forEach((bit, i) => {
    const src = i === 0 ? "instr" : `shr(${i}, instr)`;
    p(`            mstore(${hex(slot.get(bit))}, and(${src}, 1))`);
  });
  p("");
  p("            // --- uscite dei flip-flop: la parola di stato si spalma sui net ---");
  net.flops.forEach((ff, i) => {
    const src = i === 0 ? "state" : `shr(${i}, state)`;
    p(`            mstore(${hex(slot.get(ff.q))}, and(${src}, 1))`);
  });
  p("");
  p(`            // --- ${net.gates.length} NAND, in ordine topologico ---`);
  for (const g of net.ordered) {
    p(
      `            mstore(${hex(slot.get(g.y))}, iszero(and(${ref(g.a)}, ${ref(g.b)})))`
    );
  }
  p("");
  p("            // --- fronte di salita: campiono le D e ricompongo lo stato ---");
  net.flops.forEach((ff, i) => {
    const d = ref(ff.d);
    if (d === "0") return; // bit gia' a zero, niente da fare
    const shifted = i === 0 ? d : `shl(${i}, ${d})`;
    p(`            next := or(next, ${shifted})`);
  });
  p("        }");
  p("    }");
  p("");

  // ---- accessori sulle uscite ----
  const accessor = (fnName, portName, sol, doc) => {
    const bits = portToStateBits[portName];
    p(`    /// @notice ${doc}`);
    p(`    function ${fnName}(uint256 state) internal pure returns (${sol}) {`);
    if (sol === "bool") {
      p(`        return (state >> ${bits[0]}) & 1 == 1;`);
      p("    }");
      p("");
      return;
    }
    // i bit dei flip-flop sono contigui? allora basta uno shift
    const contiguous = bits.every((b, i) => b === bits[0] + i);
    if (contiguous) {
      const mask = (1n << BigInt(bits.length)) - 1n;
      p(`        return ${sol}((state >> ${bits[0]}) & 0x${mask.toString(16)});`);
    } else {
      p(`        uint256 v;`);
      bits.forEach((b, i) => {
        p(`        v |= ((state >> ${b}) & 1) << ${i};`);
      });
      p(`        return ${sol}(v);`);
    }
    p("    }");
    p("");
  };

  accessor("pc", "pc_o", "uint8", "Program counter corrente.");
  accessor("out", "out_o", "uint8", "Ultimo valore latchato sulla porta di uscita.");
  accessor("halted", "halt_o", "bool", "Vero se il processore ha incontrato HLT.");

  p("}");

  return { code: L.join("\n") + "\n", memEnd, slots: slot.size, portToStateBits };
}

function main() {
  const [jsonPath = "build/rh4.json", outPath = "src/RH4Gates.sol"] =
    process.argv.slice(2);

  const net = load(jsonPath, "rh4");
  const { code, memEnd, slots, portToStateBits } = generate(net, "RH4");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, code);

  console.log(`${outPath}`);
  console.log(`  ${net.gates.length} NAND srotolati, ${net.flops.length} flip-flop`);
  console.log(`  ${slots} net -> ${(memEnd - MEM_BASE) / 32} parole di memoria (fino a ${hex(memEnd)})`);
  for (const [name, bits] of Object.entries(portToStateBits)) {
    console.log(`  ${name} -> bit di stato [${bits.join(", ")}]`);
  }
  console.log(`  ${code.split("\n").length} righe`);
}

main();
