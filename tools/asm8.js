#!/usr/bin/env node
/**
 * asm8.js — assembler per la ISA RH-8.
 *
 *   node tools/asm8.js asm/echo8.asm build/echo8.hex8
 *
 * Produce tre file: l'.hex8 (una parola da 25 bit per riga), il .json con il
 * listato per il sito, e il .slots8.json con la ROM impacchettata come la
 * vuole il costruttore del contratto: otto parole per slot in corsie da 32
 * bit, 128 slot.
 *
 * Formato istruzione — 25 bit:
 *     [24:20] opcode   [19:16] rd   [15:12] rs   [7:0] imm   [9:0] addr
 */

const fs = require("fs");
const path = require("path");

const OPS = {
  nop:  { code: 0,  form: "none" },
  ldi:  { code: 1,  form: "rd_imm" },
  mov:  { code: 2,  form: "rd_rs" },
  add:  { code: 3,  form: "rd_rs" },
  adc:  { code: 4,  form: "rd_rs" },
  sub:  { code: 5,  form: "rd_rs" },
  sbb:  { code: 6,  form: "rd_rs" },
  and:  { code: 7,  form: "rd_rs" },
  or:   { code: 8,  form: "rd_rs" },
  xor:  { code: 9,  form: "rd_rs" },
  nand: { code: 10, form: "rd_rs" },
  not:  { code: 11, form: "rd" },
  shl:  { code: 12, form: "rd" },
  shr:  { code: 13, form: "rd" },
  rol:  { code: 14, form: "rd" },
  ror:  { code: 15, form: "rd" },
  inc:  { code: 16, form: "rd" },
  dec:  { code: 17, form: "rd" },
  cmp:  { code: 18, form: "rd_rs" },
  ld:   { code: 19, form: "ld" },   // ld rd, [rs]
  st:   { code: 20, form: "st" },   // st [rd], rs
  in:   { code: 21, form: "rd" },
  out:  { code: 22, form: "rd" },
  jmp:  { code: 23, form: "addr" },
  jz:   { code: 24, form: "addr" },
  jnz:  { code: 25, form: "addr" },
  jc:   { code: 26, form: "addr" },
  jnc:  { code: 27, form: "addr" },
  hlt:  { code: 28, form: "none" },
};

const ROM_WORDS = 1024;

function fail(line, msg) {
  console.error(`asm8: riga ${line}: ${msg}`);
  process.exit(1);
}

function parseReg(tok, line) {
  const m = /^r(\d+)$/i.exec(tok);
  if (!m) fail(line, `registro atteso, trovato "${tok}"`);
  const n = Number(m[1]);
  if (n > 15) fail(line, `registro fuori range: r${n}`);
  return n;
}

function parseMem(tok, line) {
  const m = /^\[r(\d+)\]$/i.exec(tok);
  if (!m) fail(line, `operando di memoria atteso ([rN]), trovato "${tok}"`);
  const n = Number(m[1]);
  if (n > 15) fail(line, `registro fuori range: r${n}`);
  return n;
}

function parseNum(tok, line, max) {
  const m = /^#?(0x[0-9a-f]+|\d+)$/i.exec(tok);
  if (!m) return null;
  const n = Number(m[1]);
  if (n > max) fail(line, `valore fuori range: ${tok} (max ${max})`);
  return n;
}

function assemble(src) {
  const raw = src.split("\n").map((text, i) => ({
    n: i + 1,
    text: text.replace(/;.*$/, "").trim(),
  }));

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
    if (pc >= ROM_WORDS) fail(n, `programma oltre le ${ROM_WORDS} parole`);
    stmts.push({ n, pc, text: rest });
    pc++;
  }

  const rom = new Array(ROM_WORDS).fill(0);
  const listing = [];
  for (const st of stmts) {
    const [mnemonic, ...argParts] = st.text.split(/[\s,]+/).filter(Boolean);
    const op = OPS[mnemonic.toLowerCase()];
    if (!op) fail(st.n, `istruzione sconosciuta "${mnemonic}"`);

    let rd = 0, rs = 0, low = 0;
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
        const imm = parseNum(argParts[1], st.n, 255);
        if (imm === null) fail(st.n, `immediato atteso, trovato "${argParts[1]}"`);
        low = imm;
        break;
      }
      case "ld":
        if (argParts.length !== 2) fail(st.n, `ld vuole: ld rd, [rs]`);
        rd = parseReg(argParts[0], st.n);
        rs = parseMem(argParts[1], st.n);
        break;
      case "st":
        if (argParts.length !== 2) fail(st.n, `st vuole: st [rd], rs`);
        rd = parseMem(argParts[0], st.n);
        rs = parseReg(argParts[1], st.n);
        break;
      case "addr": {
        if (argParts.length !== 1) fail(st.n, `${mnemonic} vuole 1 operando`);
        const tok = argParts[0];
        let target = parseNum(tok, st.n, ROM_WORDS - 1);
        if (target === null) {
          if (!labels.has(tok)) fail(st.n, `label non definita "${tok}"`);
          target = labels.get(tok);
        }
        low = target;
        break;
      }
    }

    const word = (op.code << 20) | (rd << 16) | (rs << 12) | low;
    rom[st.pc] = word;
    listing.push({
      pc: st.pc,
      word,
      hex: word.toString(16).padStart(7, "0"),
      src: st.text,
    });
  }

  return { rom, listing, labels: Object.fromEntries(labels) };
}

function main() {
  const [srcPath, outPath] = process.argv.slice(2);
  if (!srcPath || !outPath) {
    console.error("uso: node tools/asm8.js <sorgente.asm> <uscita.hex8>");
    process.exit(2);
  }

  const { rom, listing, labels } = assemble(fs.readFileSync(srcPath, "utf8"));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rom.map((w) => w.toString(16).padStart(7, "0")).join("\n") + "\n");

  const base = outPath.replace(/\.hex8$/, "");
  fs.writeFileSync(base + ".json",
    JSON.stringify({ source: srcPath, labels, listing }, null, 2) + "\n");

  // otto parole da 25 bit per slot, in corsie da 32: la stessa forma che
  // _fetch del contratto si aspetta
  const slots = [];
  for (let s = 0; s < 128; s++) {
    let word = 0n;
    for (let i = 0; i < 8; i++) word |= BigInt(rom[s * 8 + i]) << BigInt(i * 32);
    slots.push("0x" + word.toString(16).padStart(64, "0"));
  }
  fs.writeFileSync(base + ".slots8.json", JSON.stringify({ slots }, null, 2) + "\n");

  console.log(`${listing.length} istruzioni -> ${outPath}`);
  for (const i of listing) {
    console.log(`  ${i.pc.toString(16).padStart(3, "0")}: ${i.hex}   ${i.src}`);
  }
}

main();
