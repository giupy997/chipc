#!/usr/bin/env node
/**
 * logo.js — il marchio RH-4: un microchip inciso.
 *
 *   node tools/logo.js docs/logo.svg          illustrazione, tratteggio fitto
 *   node tools/logo.js docs/mark.svg --mark   marchio, tratteggio rado
 *   node tools/logo.js docs/icon.svg --icon   icona, nessun tratteggio (32px)
 *
 * L'incisione su acciaio non e' un effetto: e' tratteggio a spessore
 * variabile. Linee parallele fitte che si ingrossano dove l'ombra cade e si
 * assottigliano dove prende luce, piu' un secondo strato incrociato nelle
 * zone piu' scure. Qui e' fatta cosi', non imitata: ogni tratto ha lo
 * spessore che gli detta una funzione di illuminazione.
 *
 * Il soggetto e' un DIP visto dall'alto — corpo, tacca del pin 1, due file
 * di piedini, e il die scoperto con le sue piste. Simmetrico apposta: un
 * marchio deve reggere anche piccolo, e la simmetria e' cio' che sopravvive
 * alla riduzione.
 */
const fs = require("fs");

const MARK = process.argv.includes("--mark");
// A 32 px il tratteggio si impasta in grigio: l'icona ci rinuncia del tutto
// e tiene solo la sagoma. Non e' una versione povera, e' l'unica leggibile.
const ICON = process.argv.includes("--icon");
const S = 1280, C = S / 2;
const INK = "#111110", PAPER = "#efeee6", LIVE = "#1f7a4c";

// il marchio rinuncia al dettaglio: a 32px il tratteggio fitto diventa grigio
const HATCH = MARK ? 18 : 5;       // passo del tratteggio
const WMAX  = MARK ? 15 : 4.4;     // al massimo i tratti quasi si toccano
const WMIN  = MARK ? 1.6 : 0.35;   // al minimo restano capelli

const BODY_W = 560, BODY_H = 680;
const BX = C - BODY_W / 2, BY = C - BODY_H / 2;
const DIE_W = 300, DIE_H = 360;
const DX = C - DIE_W / 2, DY = C - DIE_H / 2;

const PINS = ICON ? 5 : MARK ? 6 : 9;
const PIN_W = ICON ? 112 : 92, PIN_H = ICON ? 46 : MARK ? 30 : 24;

const out = [];
const p = (s) => out.push(s);
const r = (n) => Math.round(n * 10) / 10;

/** Generatore deterministico: lo stesso marchio a ogni esecuzione. */
let seed = 20260826;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/**
 * Tratteggio di una regione, ritagliato con clipPath.
 * `light(t)` va da 0 (buio, tratto grosso) a 1 (luce, tratto sottile).
 */
function hatch(id, x, y, w, h, angle, light, pitch = HATCH) {
  if (ICON) return "";
  const lines = [];
  const diag = Math.hypot(w, h);
  const cx = x + w / 2, cy = y + h / 2;
  const n = Math.ceil(diag / pitch);
  for (let i = -n; i <= n; i++) {
    const t = (i + n) / (2 * n);
    const off = i * pitch;
    const a = (angle * Math.PI) / 180;
    // segmento perpendicolare all'offset, lungo abbastanza da coprire tutto
    const ox = Math.cos(a) * off, oy = Math.sin(a) * off;
    const dx = -Math.sin(a) * diag, dy = Math.cos(a) * diag;
    const wdt = WMIN + (WMAX - WMIN) * (1 - light(t));
    lines.push(
      `<line x1="${r(cx + ox - dx)}" y1="${r(cy + oy - dy)}" ` +
      `x2="${r(cx + ox + dx)}" y2="${r(cy + oy + dy)}" stroke-width="${r(wdt)}"/>`
    );
  }
  return `<g clip-path="url(#${id})" stroke="${INK}" stroke-linecap="butt">
${lines.join("\n")}
</g>`;
}

// ---------------------------------------------------------------- clip paths
const clips = [];
clips.push(`<clipPath id="body"><rect x="${BX}" y="${BY}" width="${BODY_W}" height="${BODY_H}" rx="16"/></clipPath>`);
clips.push(`<clipPath id="die"><rect x="${DX}" y="${DY}" width="${DIE_W}" height="${DIE_H}"/></clipPath>`);

const pinRects = [];
const pinGap = BODY_H / PINS;
for (let i = 0; i < PINS; i++) {
  const py = BY + pinGap * (i + 0.5) - PIN_H / 2;
  pinRects.push([BX - PIN_W, py], [BX + BODY_W, py]);
}
clips.push(
  `<clipPath id="pins">` +
  pinRects.map(([px, py]) => `<rect x="${r(px)}" y="${r(py)}" width="${PIN_W}" height="${PIN_H}" rx="4"/>`).join("") +
  `</clipPath>`
);

// ---------------------------------------------------------------- il disegno

// piedini: tratteggio orizzontale, luce da sinistra in alto
p(hatch("pins", BX - PIN_W, BY, BODY_W + 2 * PIN_W, BODY_H, 90,
        (t) => Math.max(0, 1 - Math.abs(t - 0.32) * 2.6), MARK ? 9 : 6));
p(pinRects.map(([px, py]) =>
  `<rect x="${r(px)}" y="${r(py)}" width="${PIN_W}" height="${PIN_H}" rx="4" ` +
  `fill="${ICON ? INK : "none"}" stroke="${INK}" stroke-width="${ICON ? 0 : MARK ? 5 : 3.4}"/>`
).join("\n"));

// corpo: tratteggio lungo l'asse del package. Il colmo di luce corre in
// mezzo e i tratti si ingrossano verso i bordi: e' quello che fa sembrare
// la superficie bombata invece che piatta.
p(hatch("body", BX, BY, BODY_W, BODY_H, 0,
        (t) => Math.max(0.02, 1 - Math.pow(Math.abs(t - 0.36) * 2.0, 1.35))));
// Niente secondo strato incrociato: a questa scala due griglie sovrapposte
// leggono come carta millimetrata invece che come ombra. Il nero lo fa il
// tratto che si ingrossa fino a toccare il vicino, che e' come lo faceva
// davvero l'incisione su acciaio.

// il die: finestra pulita che stacca dal corpo inciso
p(`<rect x="${DX}" y="${DY}" width="${DIE_W}" height="${DIE_H}" fill="${PAPER}"/>`);
p(hatch("die", DX, DY, DIE_W, DIE_H, 45, () => 0.93, HATCH * 2.6));

// piste del die: dai pad sul perimetro verso il nucleo, a scalini
// ortogonali. Simmetriche a coppie, come il routing vero di un die.
const traces = [];
const pads = [];
const LANES = ICON ? 2 : MARK ? 4 : 7;
const CORE = ICON ? 96 : MARK ? 74 : 96;
for (let side = 0; side < 4; side++) {
  const vert = side % 2 === 0;                 // 0,2 = alto/basso
  const sign = side < 2 ? -1 : 1;
  for (let i = 0; i < LANES; i++) {
    const t = (i + 1) / (LANES + 1);
    // punto di partenza sul bordo del die
    const px = vert ? DX + DIE_W * t : C + sign * (DIE_W / 2);
    const py = vert ? C + sign * (DIE_H / 2) : DY + DIE_H * t;
    pads.push([px, py, vert]);
    // scalino: prima verso il centro, poi allineamento, poi al nucleo
    const depth = 26 + i * (MARK ? 10 : 8);
    if (vert) {
      const midY = py - sign * depth;
      const endX = C + (px < C ? -CORE : CORE);
      traces.push(`M ${r(px)} ${r(py)} V ${r(midY)} H ${r(endX)} V ${r(C - sign * CORE)}`);
    } else {
      const midX = px - sign * depth;
      const endY = C + (py < C ? -CORE : CORE);
      traces.push(`M ${r(px)} ${r(py)} H ${r(midX)} V ${r(endY)} H ${r(C - sign * CORE)}`);
    }
  }
}
p(`<g clip-path="url(#die)" fill="none" stroke="${INK}" stroke-width="${ICON ? 14 : MARK ? 4 : 2.2}" stroke-linecap="butt" stroke-linejoin="miter">
${traces.map((d) => `<path d="${d}"/>`).join("\n")}
</g>`);
// i pad sul bordo del die
p(pads.map(([px, py, vert]) => {
  const w = vert ? (ICON ? 30 : MARK ? 14 : 10) : (ICON ? 18 : MARK ? 8 : 6);
  const h = vert ? (ICON ? 18 : MARK ? 8 : 6) : (ICON ? 30 : MARK ? 14 : 10);
  return `<rect x="${r(px - w / 2)}" y="${r(py - h / 2)}" width="${w}" height="${h}" fill="${INK}"/>`;
}).join("\n"));
// il nucleo, che e' dove tutte le piste convergono
p(`<rect x="${r(C - CORE)}" y="${r(C - CORE)}" width="${r(CORE * 2)}" height="${r(CORE * 2)}" fill="none" stroke="${INK}" stroke-width="${ICON ? 20 : MARK ? 5 : 3}"/>`);

// il quadrato acceso al centro: l'unico colore di tutta l'incisione
const LIT = ICON ? 150 : MARK ? 54 : 42;
p(`<rect x="${r(C - LIT / 2)}" y="${r(C - LIT / 2)}" width="${LIT}" height="${LIT}" fill="${LIVE}"/>`);

// contorni forti: senza questi il tratteggio si sfalda
p(`<rect x="${DX}" y="${DY}" width="${DIE_W}" height="${DIE_H}" fill="none" stroke="${INK}" stroke-width="${ICON ? 26 : MARK ? 7 : 4.6}"/>`);
p(`<rect x="${BX}" y="${BY}" width="${BODY_W}" height="${BODY_H}" rx="16" fill="none" stroke="${INK}" stroke-width="${ICON ? 34 : MARK ? 9 : 6}"/>`);

// la tacca del pin 1, in alto: e' il dettaglio che dice "questo e' un chip"
const NOTCH = ICON ? 84 : MARK ? 62 : 52;
p(`<path d="M ${r(C - NOTCH)} ${BY} A ${NOTCH} ${NOTCH} 0 0 0 ${r(C + NOTCH)} ${BY} Z" fill="${PAPER}"/>`);
p(`<path d="M ${r(C - NOTCH)} ${BY} A ${NOTCH} ${NOTCH} 0 0 0 ${r(C + NOTCH)} ${BY}" fill="none" stroke="${INK}" stroke-width="${ICON ? 34 : MARK ? 9 : 6}"/>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
<defs>
${clips.join("\n")}
</defs>
<rect width="${S}" height="${S}" fill="${PAPER}"/>
${out.join("\n")}
</svg>
`;

const dest = process.argv[2] || (ICON ? "docs/icon.svg" : MARK ? "docs/mark.svg" : "docs/logo.svg");
fs.writeFileSync(dest, svg);
console.log(`${dest}  ${(svg.length / 1024).toFixed(1)} kB  (${ICON ? "icona" : MARK ? "marchio" : "illustrazione"})`);
