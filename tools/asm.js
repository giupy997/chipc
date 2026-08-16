#!/usr/bin/env node
/**
 * asm.js — assembler per la ISA RH-4.
 *
 *   node tools/asm.js asm/fib.asm build/rom.hex
 *
 * Produce due file: il .hex (una parola da 12 bit per riga, per $readmemh e
 * per la testbench) e un .json affiancato con il listato, che serve poi al
 * wrapper Solidity per inizializzare la ROM immutable.
 */

const fs = require("fs");
const path = require("path");

const OPS = {
  nop:  { code: 0x0, form: "none" },
  ldi:  { code: 0x1, form: "rd_imm" },
  mov:  { code: 0x2, form: "rd_rs" },
  add:  { code: 0x3, form: "rd_rs" },
  adc:  { code: 0x4, form: "rd_rs" },
  sub:  { code: 0x5, form: "rd_rs" },
  nand: { code: 0x6, form: "rd_rs" },
  xor:  { code: 0x7, form: "rd_rs" },
  shr:  { code: 0x8, form: "rd" },
  inc:  { code: 0x9, form: "rd" },
  jmp:  { code: 0xa, form: "addr" },
  jz:   { code: 0xb, form: "addr" },
  jc:   { code: 0xc, form: "addr" },
  jnz:  { code: 0xd, form: "addr" },
  out:  { code: 0xe, form: "rd" },
  hlt:  { code: 0xf, form: "none" },
};

const ROM_WORDS = 256;

function fail(line, msg) {
  console.error(`asm: riga ${line}: ${msg}`);
  process.exit(1);
}

function parseReg(tok, line) {
  const m = /^r(\d+)$/i.exec(tok);
  if (!m) fail(line, `registro atteso, trovato "${tok}"`);
  const n = Number(m[1]);
  if (n > 15) fail(line, `registro fuori range: r${n} (max r15)`);
  return n;
}

function parseNum(tok, line, max) {
  const m = /^#?(0x[0-9a-f]+|\d+)$/i.exec(tok);
  if (!m) return null;
  const n = Number(m[1]);
  if (n > max) fail(line, `immediato fuori range: ${tok} (max ${max})`);
  return n;
}

function assemble(src) {
  // pulizia: via i commenti, via le righe vuote, tengo il numero di riga vero
  const raw = src.split("\n").map((text, i) => ({
    n: i + 1,
    text: text.replace(/;.*$/, "").trim(),
  }));

  // passata 1 — raccolgo le label e la loro posizione
  const labels = new Map();
  const stmts = [];
  let pc = 0;
  for (const { n, text } of raw) {
    let rest = text;
    while (true) {
      const m = /^([A-Za-z_][\w]*)\s*:\s*/.exec(rest);
      if (!m) break;
      if (labels.has(m[1])) fail(n, `label duplicata "${m[1]}"`);
      labels.set(m[1], pc);
      rest = rest.slice(m[0].length);
    }
    if (!rest) continue;
    if (pc >= ROM_WORDS) fail(n, `programma oltre le ${ROM_WORDS} parole di ROM`);
    stmts.push({ n, pc, text: rest });
    pc++;
  }

  // passata 2 — codifico
  const rom = new Array(ROM_WORDS).fill(0);
  const listing = [];
  for (const st of stmts) {
    const [mnemonic, ...argParts] = st.text.split(/[\s,]+/).filter(Boolean);
    const op = OPS[mnemonic.toLowerCase()];
    if (!op) fail(st.n, `istruzione sconosciuta "${mnemonic}"`);

    let rd = 0;
    let rs = 0;
    switch (op.form) {
      case "none":
        if (argParts.length) fail(st.n, `${mnemonic} non vuole operandi`);
        break;
      case "rd":
        if (argParts.length !== 1) fail(st.n, `${mnemonic} vuole 1 operando`);
        rd = parseReg(argParts[0], st.n);
        break;
      case "rd_rs":
        if (argParts.length !== 2) fail(st.n, `${mnemonic} vuole 2 operandi`);
        rd = parseReg(argParts[0], st.n);
        rs = parseReg(argParts[1], st.n);
        break;
      case "rd_imm": {
        if (argParts.length !== 2) fail(st.n, `${mnemonic} vuole 2 operandi`);
        rd = parseReg(argParts[0], st.n);
        const imm = parseNum(argParts[1], st.n, 15);
        if (imm === null) fail(st.n, `immediato atteso, trovato "${argParts[1]}"`);
        rs = imm;
        break;
      }
      case "addr": {
        if (argParts.length !== 1) fail(st.n, `${mnemonic} vuole 1 operando`);
        const tok = argParts[0];
        let target = parseNum(tok, st.n, ROM_WORDS - 1);
        if (target === null) {
          if (!labels.has(tok)) fail(st.n, `label non definita "${tok}"`);
          target = labels.get(tok);
        }
        rd = (target >> 4) & 0xf;
        rs = target & 0xf;
        break;
      }
    }

    const word = (op.code << 8) | (rd << 4) | rs;
    rom[st.pc] = word;
    listing.push({
      pc: st.pc,
      word,
      hex: word.toString(16).padStart(3, "0"),
      src: st.text,
    });
  }

  return { rom, listing, labels: Object.fromEntries(labels) };
}

function main() {
  const [srcPath, outPath] = process.argv.slice(2);
  if (!srcPath || !outPath) {
    console.error("uso: node tools/asm.js <sorgente.asm> <uscita.hex>");
    process.exit(2);
  }

  const { rom, listing, labels } = assemble(fs.readFileSync(srcPath, "utf8"));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    rom.map((w) => w.toString(16).padStart(3, "0")).join("\n") + "\n"
  );
  const jsonPath = outPath.replace(/\.hex$/, "") + ".json";
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ source: srcPath, labels, listing }, null, 2) + "\n"
  );

  // Stessa ROM impacchettata come la vuole il contratto: 16 slot da 256 bit,
  // 16 istruzioni da 16 bit ciascuno. I 4 bit di troppo per istruzione sono
  // il prezzo per non avere parole a cavallo di due slot.
  const slots = [];
  for (let s = 0; s < 16; s++) {
    let word = 0n;
    for (let i = 0; i < 16; i++) {
      word |= BigInt(rom[s * 16 + i]) << BigInt(i * 16);
    }
    slots.push("0x" + word.toString(16).padStart(64, "0"));
  }
  const slotsPath = outPath.replace(/\.hex$/, "") + ".slots.json";
  fs.writeFileSync(slotsPath, JSON.stringify({ slots }, null, 2) + "\n");

  console.log(`${listing.length} istruzioni -> ${outPath}`);
  for (const i of listing) {
    console.log(`  ${i.pc.toString(16).padStart(2, "0")}: ${i.hex}   ${i.src}`);
  }
}

main();
