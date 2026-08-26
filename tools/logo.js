#!/usr/bin/env node
/**
 * logo.js — genera il marchio RH-4.
 *
 * Il disegno e' geometria pura, non un'immagine da ritoccare: quattro bracci
 * di linee parallele lungo gli assi, quattro angoli smussati da diagonali a
 * 45 gradi, e al centro una griglia con un solo quadrato acceso.
 *
 * La cosa che tiene insieme il tutto e' il ritaglio: bracci e diagonali non
 * si sovrappongono mai perche' occupano regioni disgiunte — i bracci la
 * fascia centrale larga 2A, le diagonali quello che resta agli angoli.
 */
const fs = require("fs");

const S = 1280, C = S / 2;
const INK = "#111110", PAPER = "#efeee6", LIVE = "#1f7a4c";

const W = 9;              // spessore tratto
const R_IN = 150;         // dove comincia il disegno, dal centro
const R_OUT = 535;        // dove finisce

const ARM_LINES = 6, ARM_PITCH = 41;
const A = ((ARM_LINES - 1) * ARM_PITCH) / 2;   // semilarghezza della fascia

const DIAG_PITCH = 58;    // passo fra una diagonale e l'altra

const r = (n) => Math.round(n * 10) / 10;
const seg = [];
const line = (x1, y1, x2, y2) =>
  seg.push(`<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}"/>`);

// --- bracci: quattro rotazioni dello stesso fascio verticale ---
for (let q = 0; q < 4; q++) {
  const a = (q * Math.PI) / 2, cos = Math.cos(a), sin = Math.sin(a);
  const rot = (x, y) => [C + x * cos - y * sin, C + x * sin + y * cos];
  for (let i = 0; i < ARM_LINES; i++) {
    const off = (i - (ARM_LINES - 1) / 2) * ARM_PITCH;
    const [x1, y1] = rot(off, -R_IN);
    const [x2, y2] = rot(off, -R_OUT);
    line(x1, y1, x2, y2);
  }
}

// --- angoli: diagonali parallele alla bisettrice dell'angolo ---
// In coordinate locali (u,v = distanza dal centro lungo i due assi) la
// famiglia e' u - v = k: la piu' lunga corre sulla diagonale stessa, le
// altre le stanno a fianco e si accorciano. Il vincolo u,v in [A, R_OUT]
// e' quello che le tiene fuori dalle fasce dei bracci.
for (let q = 0; q < 4; q++) {
  const sx = q === 0 || q === 3 ? -1 : 1;
  const sy = q === 0 || q === 1 ? -1 : 1;
  const kMax = R_OUT - A;
  for (let k = -kMax; k <= kMax; k += DIAG_PITCH) {
    const uMin = Math.max(A, A + k);
    const uMax = Math.min(R_OUT, R_OUT + k);
    if (uMax - uMin < 20) continue;
    line(C + sx * uMin, C + sy * (uMin - k), C + sx * uMax, C + sy * (uMax - k));
  }
}

// --- la griglia al centro ---
const N = 5, CELL = 30, PITCH = 47;
const span = (N - 1) * PITCH + CELL;
const start = C - span / 2;
const grid = [];
for (let row = 0; row < N; row++) {
  for (let col = 0; col < N; col++) {
    const on = row === (N - 1) / 2 && col === (N - 1) / 2;
    grid.push(
      `<rect x="${r(start + col * PITCH)}" y="${r(start + row * PITCH)}" ` +
      `width="${CELL}" height="${CELL}" fill="${on ? LIVE : INK}"/>`
    );
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
<rect width="${S}" height="${S}" fill="${PAPER}"/>
<g stroke="${INK}" stroke-width="${W}" stroke-linecap="round">
${seg.join("\n")}
</g>
${grid.join("\n")}
</svg>
`;

const dest = process.argv[2] || "docs/logo.svg";
fs.writeFileSync(dest, svg);
console.log(`${dest}  ${(svg.length / 1024).toFixed(1)} kB, ${seg.length} linee, ${grid.length} quadrati`);
