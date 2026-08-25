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

function generate(net, topName, jsonPath) {
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

  // --- registri -------------------------------------------------------------
  // Yosys conserva i nomi RTL delle net, quindi si ricava quale flip-flop e'
  // quale registro senza aggiungere porte di debug al processore. Le basi
  // finiscono impacchettate in una costante: Solidity non ha array costanti.
  const design = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const named = design.modules[topName.toLowerCase()].netnames;
  const regBases = [];
  for (let i = 0; i < 16; i++) {
    const entry = named[`regs[${i}]`];
    if (!entry) throw new Error(`regs[${i}] non rintracciabile nella netlist`);
    const bits = entry.bits.map((b) => flopIndexByQ.get(b));
    if (bits.some((b) => b === undefined)) throw new Error(`regs[${i}] non registrato`);
    if (!bits.every((b, k) => b === bits[0] + k)) {
      throw new Error(`i bit di regs[${i}] non sono contigui: ${bits}`);
    }
    regBases.push(bits[0]);
  }
  let regPacked = 0n;
  regBases.forEach((b, i) => { regPacked |= BigInt(b) << BigInt(i * 8); });

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

  p("}");

  // ---- seconda libreria: solo lettura della parola di stato ----------------
  // Sta a parte perche' chi vuole solo sapere a che punto e' un processore
  // non deve portarsi dietro i 18 kB dei gate srotolati. Il ChipFactory
  // importa questa, il GateArray importa quella sopra.
  const S = [];
  const q = (s = "") => S.push(s);

  q("// SPDX-License-Identifier: MIT");
  q("pragma solidity ^0.8.24;");
  q("");
  q("// ┌───────────────────────────────────────────────────────────────────┐");
  q("// │  GENERATO DA tools/codegen.js — NON MODIFICARE A MANO.             │");
  q("// │  Posizioni dei bit dentro la parola di stato della RH-4.           │");
  q("// └───────────────────────────────────────────────────────────────────┘");
  q("");
  q(`library ${topName}State {`);
  q(`    uint256 internal constant BITS = ${net.flops.length};`);
  q(`    uint256 internal constant MASK = (uint256(1) << ${net.flops.length}) - 1;`);
  q("");

  const emit = (fnName, portName, sol, doc) => {
    const bits = portToStateBits[portName];
    q(`    /// @notice ${doc}`);
    q(`    function ${fnName}(uint256 state) internal pure returns (${sol}) {`);
    if (sol === "bool") {
      q(`        return (state >> ${bits[0]}) & 1 == 1;`);
    } else {
      const contiguous = bits.every((b, i) => b === bits[0] + i);
      if (contiguous) {
        const mask = (1n << BigInt(bits.length)) - 1n;
        q(`        return ${sol}((state >> ${bits[0]}) & 0x${mask.toString(16)});`);
      } else {
        q(`        uint256 v;`);
        bits.forEach((b, i) => q(`        v |= ((state >> ${b}) & 1) << ${i};`));
        q(`        return ${sol}(v);`);
      }
    }
    q("    }");
    q("");
  };

  emit("pc", "pc_o", "uint8", "Program counter corrente.");
  emit("out", "out_o", "uint8", "Ultimo valore latchato sulla porta di uscita.");
  emit("halted", "halt_o", "bool", "Vero se il processore ha incontrato HLT.");

  // i registri servono al renderer dell'NFT e ai frontend
  q(`    /// @dev Base di ciascuno dei 16 registri, otto bit per voce.`);
  q(`    uint256 internal constant REG_BASES = 0x${regPacked.toString(16)};`);
  q("");
  q("    /// @notice Uno dei sedici registri da 4 bit.");
  q("    function reg(uint256 state, uint256 i) internal pure returns (uint8) {");
  q("        return uint8((state >> ((REG_BASES >> (i * 8)) & 0xff)) & 0xf);");
  q("    }");
  q("");
  q("}");

  return {
    code: L.join("\n") + "\n",
    stateCode: S.join("\n") + "\n",
    memEnd,
    slots: slot.size,
    portToStateBits,
  };
}

function main() {
  const [jsonPath = "build/rh4.json", outPath = "src/RH4Gates.sol"] =
    process.argv.slice(2);

  const net = load(jsonPath, "rh4");
  const { code, stateCode, memEnd, slots, portToStateBits } =
    generate(net, "RH4", jsonPath);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, code);

  const statePath = path.join(path.dirname(outPath), "RH4State.sol");
  fs.writeFileSync(statePath, stateCode);

  console.log(`${outPath}  +  ${statePath}`);
  console.log(`  ${net.gates.length} NAND srotolati, ${net.flops.length} flip-flop`);
  console.log(`  ${slots} net -> ${(memEnd - MEM_BASE) / 32} parole di memoria (fino a ${hex(memEnd)})`);
  for (const [name, bits] of Object.entries(portToStateBits)) {
    console.log(`  ${name} -> bit di stato [${bits.join(", ")}]`);
  }
  console.log(`  ${code.split("\n").length} righe`);
}

main();
