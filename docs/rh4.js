/**
 * rh4.js — the RH-8, running in your browser.
 *
 * This is not an animation of a processor. It is the processor: the same
 * netlist the contract interprets on-chain — 2,368 NAND gates in topological
 * order, flip-flops latching together — plus its 256 bytes of RAM and the
 * input port, both handled here exactly as the contract handles them.
 */
(function () {
  "use strict";

  const D = window.RH8_DATA;

  // ---------------------------------------------------------------- machine

  class Machine {
    constructor(program) {
      this.program = program;
      this.nets = new Uint8Array(D.nets);
      this.next = new Uint8Array(D.flopCount);
      this.heat = new Float32Array(D.gateCount);
      this.ram = new Uint8Array(256);
      this.inPort = 0; // il byte che lo sponsor passa a tick()
      this.reset();
    }

    reset() {
      this.nets.fill(0);
      this.nets[D.one] = 1;
      this.heat.fill(0);
      this.ram.fill(0);
      this.cycle = 0;
      this.lastInstr = this.program.rom[0] || 0;
    }

    flop(i) {
      return this.nets[D.flops[2 * i + 1]];
    }

    field(bits) {
      let n = 0;
      for (let i = 0; i < bits.length; i++) n |= this.flop(bits[i]) << i;
      return n;
    }

    pc()     { return this.field(D.pc); }
    out()    { return this.field(D.out); }
    reg(r)   { return this.field(D.regs[r]); }
    carry()  { return this.flop(D.cf); }
    zero()   { return this.flop(D.zf); }
    halted() { return this.flop(D.halt) === 1; }

    ramAddr()  { return this.field(D.ramAddr); }
    ramWdata() { return this.field(D.ramWdata); }
    ramWe()    { return this.flop(D.ramWe) === 1; }

    /** One clock tick. On-chain this is one block. */
    tick() {
      const v = this.nets;
      const word = this.program.rom[this.pc()] || 0;
      for (let i = 0; i < 25; i++) v[D.instr[i]] = (word >> i) & 1;
      for (let i = 0; i < 8; i++) v[D.inPort[i]] = (this.inPort >> i) & 1;
      // l'indirizzo e' quello latchato dal ciclo scorso: la load a due cicli
      const rdata = this.ram[this.ramAddr()];
      for (let i = 0; i < 8; i++) v[D.ramRdata[i]] = (rdata >> i) & 1;

      // combinational cone, in the order the topological sort fixed
      const g = D.gates;
      const heat = this.heat;
      for (let i = 0, k = 0; i < g.length; i += 3, k++) {
        const y = g[i + 2];
        const val = 1 - (v[g[i]] & v[g[i + 1]]);
        if (v[y] !== val) {
          v[y] = val;
          heat[k] = 1;
        }
      }

      // sample every D before switching: the flops move together
      const f = D.flops;
      const nx = this.next;
      for (let i = 0; i < D.flopCount; i++) nx[i] = v[f[2 * i]];
      for (let i = 0; i < D.flopCount; i++) v[f[2 * i + 1]] = nx[i];

      if (this.ramWe()) this.ram[this.ramAddr()] = this.ramWdata();

      this.cycle++;
      this.lastInstr = word;
      return word;
    }
  }

  // ------------------------------------------------------------- disassembly

  const MNEMONIC = [
    "nop", "ldi", "mov", "add", "adc", "sub", "sbb", "and",
    "or", "xor", "nand", "not", "shl", "shr", "rol", "ror",
    "inc", "dec", "cmp", "ld", "st", "in", "out", "jmp",
    "jz", "jnz", "jc", "jnc", "hlt",
  ];
  const hex2 = (n) => "0x" + n.toString(16).padStart(2, "0");
  const hex3 = (n) => "0x" + n.toString(16).padStart(3, "0");

  function disasm(word) {
    const op = (word >>> 20) & 0x1f;
    const rd = (word >>> 16) & 0xf;
    const rs = (word >>> 12) & 0xf;
    const m = MNEMONIC[op] || "?";
    if (op === 0 || op === 28) return m;                       // nop, hlt
    if (op === 1) return `${m} r${rd}, #${word & 0xff}`;        // ldi
    if (op === 19) return `${m} r${rd}, [r${rs}]`;              // ld
    if (op === 20) return `${m} [r${rd}], r${rs}`;              // st
    if (op >= 23 && op <= 27) return `${m} ${hex3(word & 0x3ff)}`; // salti
    if ((op >= 2 && op <= 10) || op === 18) return `${m} r${rd}, r${rs}`;
    return `${m} r${rd}`;                                       // rd-only
  }

  // ------------------------------------------------------------------ the die

  const LIT_R = 143, LIT_G = 232, LIT_B = 176; // mint, same as the page accent
  const COLD = "#171a16";

  class Die {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.canvas.clientWidth;
      if (!w) return;

      // Celle piu' fitte: con 2.368 porte il pannello a celle larghe
      // diventava una torre che schiacciava tutto il resto dell'eroe.
      this.cols = Math.max(40, Math.min(96, Math.round(w / 8)));
      this.rows = Math.ceil(D.gateCount / this.cols);
      this.cell = w / this.cols;

      const h = Math.round(this.cell * this.rows);
      this.canvas.style.height = `${h}px`;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.dirty = true;
    }

    /**
     * Repainting 1,029 rectangles every frame forever is wasteful when the
     * die is cold — a paused processor would still burn a core. Draw only
     * while something is fading, plus one final frame to settle.
     */
    draw(machine) {
      if (!this.cols) return;
      const heat = machine.heat;
      let hot = false;
      for (let k = 0; k < D.gateCount; k++) {
        if (heat[k] > 0.02) { hot = true; break; }
      }
      if (!hot && !this.dirty) return;
      this.dirty = hot;

      const { ctx, cell, cols } = this;
      const w = this.canvas.clientWidth;
      const h = parseFloat(this.canvas.style.height);
      ctx.fillStyle = "#07080a";
      ctx.fillRect(0, 0, w, h);

      const pad = Math.max(0.5, cell * 0.18);
      const size = cell - pad;

      for (let k = 0; k < D.gateCount; k++) {
        const x = (k % cols) * cell;
        const y = Math.floor(k / cols) * cell;
        const t = heat[k];
        if (t > 0.02) {
          // a gate that just flipped burns bright, then fades
          ctx.fillStyle = `rgba(${LIT_R},${LIT_G},${LIT_B},${0.16 + t * 0.84})`;
          heat[k] = t * 0.86;
        } else {
          ctx.fillStyle = COLD;
          heat[k] = 0;
        }
        ctx.fillRect(x, y, size, size);
      }
    }
  }

  // ------------------------------------------------------- the chip card

  /**
   * Lo stesso disegno che ChipRenderer.sol costruisce on-chain, ricostruito
   * qui con le stesse coordinate. Non e' una mockup: e' cosa uscira' da
   * `tokenURI` una volta coniato.
   */
  const PANEL_BG = "#0c0d0b";
  const PANEL_LINE = "#272a25";
  const PANEL_DIM = "#6f7669";
  const MINT_HEX = "#8fe8b0";

  /** Stesso filtro del contratto: un nome non deve poter iniettare markup. */
  function safeName(raw) {
    let out = "";
    for (const ch of String(raw).slice(0, 32)) {
      const c = ch.charCodeAt(0);
      const ok = c >= 0x20 && c <= 0x7e &&
        c !== 0x3c && c !== 0x3e && c !== 0x26 && c !== 0x22 && c !== 0x27;
      out += ok ? ch : " ";
    }
    return out;
  }

  /** Stessa regola del contratto: 1-8 fra A-Z, 0-9 e trattino. */
  function safeTicker(raw) {
    return String(raw).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 8);
  }

  function text(x, y, size, fill, body, anchor) {
    return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ` +
      `letter-spacing="1.4" text-anchor="${anchor || "start"}">${body}</text>`;
  }

  function row(y, k, v) {
    return `<line x1="40" y1="${y - 20}" x2="380" y2="${y - 20}" stroke="${PANEL_LINE}" stroke-width="1.5"/>` +
      text(40, y, 10, PANEL_DIM, k) +
      text(380, y, 16, MINT_HEX, v, "end");
  }

  function chipSvg(o) {
    const badge = o.ticker
      ? `<rect x="40" y="76" width="${26 + o.ticker.length * 11}" height="22" fill="${MINT_HEX}"/>` +
        text(53, 92, 13, PANEL_BG, o.ticker)
      : "";

    let leds = "";
    for (let i = 0; i < 8; i++) {
      const on = (o.out >> (7 - i)) & 1;
      leds += `<rect x="${40 + i * 43}" y="176" width="35" height="35" ` +
        (on ? `fill="${MINT_HEX}"/>`
            : `fill="#14171a" stroke="${PANEL_LINE}" stroke-width="1.5"/>`);
    }

    const status = o.halted
      ? `<rect x="40" y="348" width="120" height="24" fill="#f5c842"/>` +
        text(52, 365, 11, PANEL_BG, "HALTED")
      : text(40, 365, 11, MINT_HEX, "RUNNING / 1 TICK PER BLOCK");

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">` +
      `<rect width="420" height="420" fill="${PANEL_BG}"/>` +
      `<rect x="24" y="24" width="372" height="372" fill="none" stroke="${PANEL_LINE}" stroke-width="1.5"/>` +
      `<g font-family="ui-monospace,monospace">` +
      `<rect x="24" y="24" width="372" height="34" fill="none" stroke="${PANEL_LINE}" stroke-width="1.5"/>` +
      `<rect x="40" y="37" width="7" height="7" fill="${MINT_HEX}"/>` +
      text(56, 46, 10, PANEL_DIM, "RH-4 / GATE ARRAY") +
      text(380, 46, 10, PANEL_DIM, "#\u2014", "end") +
      badge +
      text(40, 134, 26, "#efeee6", o.name) +
      text(40, 156, 10, PANEL_DIM, "2368 NAND / 171 FLIP-FLOPS / 256 B RAM") +
      leds +
      row(250, "CYCLES", o.cycles) +
      row(288, "PC", "0x" + o.pc.toString(16).padStart(3, "0")) +
      row(326, "OUT", String(o.out)) +
      status +
      `</g></svg>`;
  }

  // ------------------------------------------------------------- the wallet

  /**
   * Il bottone che alimenta un chip. Nessuna libreria: `tick(uint256)` e'
   * un selettore piu' un uint256 in padding, e il wallet fa il resto.
   *
   * Finche' config.factory e' null il bottone resta spento e lo dice: meglio
   * un bottone onesto che uno che finge.
   */
  const SELECTOR_TICK = "0xe5bbf637"; // tick(uint256,uint8)
  const SELECTOR_MINT = "0x481aebcf"; // mint(uint256[128],bytes32,bytes32,string,uint16,uint64)
  const SELECTOR_BYTICKER = "0x4da5bb73"; // chipByTicker(bytes32)
  const TOPIC_MINTED = "0xe16ebcd5826e8fad06bc57cf29dbfb38c93766eb6df5320acceb51366f717d37";
  const CFG = () => window.RH4_CONFIG || {};

  class Wallet {
    constructor(cfg) {
      this.cfg = cfg;
      this.account = null;
      this.connectBtn = $("#w-connect");
      this.tickBtn = $("#w-tick");
      this.statusEl = $("#w-status");
      if (!this.connectBtn) return;

      // L'NFT rimanda qui con ?chip=N: chi arriva dai metadati deve trovarsi
      // davanti a quel processore, non a quello di default.
      const asked = Number(new URLSearchParams(location.search).get("chip"));
      this.chipId = Number.isInteger(asked) && asked > 0 ? asked : (cfg.defaultChip || 1);
      this.tickBtn.textContent = `POWER CHIP #${this.chipId}`;

      if (cfg.factory) {
        const cli = $("#w-cli");
        if (cli) cli.textContent = cli.textContent.replace("$FACTORY", cfg.factory);
      }

      this.connectBtn.addEventListener("click", () => this.connect());
      this.tickBtn.addEventListener("click", () => this.tick());
      this.refresh();
    }

    get provider() {
      return typeof window !== "undefined" ? window.ethereum : undefined;
    }

    say(msg, bad) {
      this.statusEl.textContent = msg;
      this.statusEl.classList.toggle("is-bad", Boolean(bad));
    }

    refresh() {
      if (!this.cfg.factory) {
        this.tickBtn.disabled = true;
        this.connectBtn.disabled = true;
        this.say("not deployed yet — the button opens at launch");
        return;
      }
      if (!this.provider) {
        this.tickBtn.disabled = true;
        this.say("no wallet found in this browser", true);
        return;
      }
      this.tickBtn.disabled = !this.account;
      if (this.account) {
        this.connectBtn.textContent = this.account.slice(0, 6) + "…" + this.account.slice(-4);
        this.say("one tick per block — first one in wins the cycle");
      }
    }

    async connect() {
      if (!this.provider) return this.say("no wallet found in this browser", true);
      try {
        const [acc] = await this.provider.request({ method: "eth_requestAccounts" });
        this.account = acc;
        await this.ensureChain();
        this.refresh();
      } catch (e) {
        this.say(short(e), true);
      }
    }

    /** Il chip vive su una chain sola: se il wallet sta altrove, si sposta. */
    async ensureChain() {
      const { chainIdHex, chainName, rpc, explorer } = this.cfg;
      try {
        await this.provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainIdHex }],
        });
      } catch (e) {
        // 4902: la chain non c'e' ancora nel wallet, quindi la aggiungiamo
        if (e && e.code === 4902) {
          await this.provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: chainIdHex,
              chainName,
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [rpc],
              blockExplorerUrls: [explorer],
            }],
          });
        } else {
          throw e;
        }
      }
    }

    async tick() {
      if (!this.account || !this.cfg.factory) return;
      this.tickBtn.disabled = true;
      this.say("confirm in your wallet…");
      try {
        await this.ensureChain();
        // il byte da dare in pasto al processore con questo ciclo
        const byteEl = document.querySelector("#w-byte");
        const inByte = Math.max(0, Math.min(255, Number(byteEl && byteEl.value) || 0));
        const data = SELECTOR_TICK +
          BigInt(this.chipId).toString(16).padStart(64, "0") +
          BigInt(inByte).toString(16).padStart(64, "0");
        const hash = await this.provider.request({
          method: "eth_sendTransaction",
          params: [{ from: this.account, to: this.cfg.factory, data }],
        });
        this.say(`sent — ${hash.slice(0, 10)}… waiting`);
        await this.report(hash);
      } catch (e) {
        this.say(short(e), true);
      } finally {
        this.tickBtn.disabled = false;
      }
    }

    /**
     * Aspetta la ricevuta e dice com'e' andata.
     *
     * Senza questo il bottone diceva "sent" e taceva: una transazione che
     * fallisce perche' qualcun altro ha gia' ticchettato quel blocco costa
     * gas e non lascia traccia a schermo. Chi clicca deve sapere se il ciclo
     * l'ha preso lui.
     */
    async report(hash) {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        let receipt;
        try {
          receipt = await this.provider.request({
            method: "eth_getTransactionReceipt",
            params: [hash],
          });
        } catch {
          continue;
        }
        if (!receipt) continue;

        if (receipt.status === "0x1") {
          return this.say("cycle is yours — you are in the Cycle event for it");
        }
        // one tick per block: quasi sempre vuol dire che ti hanno battuto
        return this.say("someone ticked that block first — the cycle went to them", true);
      }
      this.say("still pending — check your wallet");
    }
  }

  function short(e) {
    const m = String((e && (e.shortMessage || e.message)) || e);
    return m.split("\n")[0].slice(0, 90);
  }

  // --------------------------------------------------------------------- ui

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  /**
   * Con cosa un chip puo' essere accoppiato. La fabbrica non lo sa e non gli
   * serve saperlo: un chip conosce solo il proprio token. La coppia si decide
   * dopo, quando si apre il pool.
   *
   * `depth` e' il fondo del pool di riferimento con WETH, misurato sulla
   * chain: senza quello non si sa quanto vale un'unita' in ETH, e il range
   * finirebbe piazzato su un cambio inventato.
   */
  const PAIRS = {
    weth: { label: "WETH", note: "priced in ether directly" },
    nvda: { label: "NVDA", note: "NVIDIA · ~0.086 ETH a share" },
  };

  const RATES = [
    { hz: 10, label: "10 HZ", note: "one tick per block" },
    { hz: 40, label: "40 HZ", note: "4× fast-forward" },
    { hz: 2,  label: "2 HZ",  note: "slow" },
  ];

  class UI {
    constructor() {
      this.programName = "echo8";
      this.machine = new Machine(D.programs.echo8);
      this.die = new Die($("#die"));
      this.rate = RATES[0];
      this.running = true;
      this.acc = 0;
      this.last = performance.now();
      this.shown = {};

      this.buildLeds();
      this.buildRegisters();
      this.buildListing();
      this.buildControls();
      this.buildMintForm();

      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
      setInterval(() => this.wallClock(), 1000);
      this.wallClock();
    }

    // ---- construction

    buildLeds() {
      this.leds = [];
      const host = $("#leds");
      for (let i = 7; i >= 0; i--) {
        const led = el("div", "led");
        led.dataset.bit = String(i);
        host.appendChild(led);
        this.leds[i] = led;
      }
    }

    buildRegisters() {
      this.regCells = [];
      const host = $("#registers");
      for (let r = 0; r < 16; r++) {
        const cell = el("div", "reg");
        cell.appendChild(el("span", "reg-name", `R${r}`));
        const val = el("span", "reg-val", "0");
        cell.appendChild(val);
        host.appendChild(cell);
        this.regCells.push({ cell, val });
      }
    }

    buildListing() {
      const host = this.listingHost = $("#listing");
      host.innerHTML = "";
      this.lines = new Map();
      this.shownPc = undefined;
      for (const ins of this.machine.program.listing) {
        const line = el("div", "line");
        line.appendChild(el("span", "addr", ins.pc.toString(16).padStart(2, "0")));
        line.appendChild(el("span", "word", ins.hex));
        line.appendChild(el("span", "src", ins.src));
        host.appendChild(line);
        this.lines.set(ins.pc, line);
      }
    }

    buildControls() {
      $("#toggle").addEventListener("click", () => {
        this.running = !this.running;
        this.syncToggle();
      });
      $("#step").addEventListener("click", () => {
        this.running = false;
        this.syncToggle();
        this.machine.tick();
        this.render();
      });
      $("#reset").addEventListener("click", () => {
        this.machine.reset();
        this.die.dirty = true;
        this.render();
      });

      const rateHost = $("#rates");
      this.rateButtons = RATES.map((r) => {
        const b = el("button", "chip", r.label);
        b.title = r.note;
        b.addEventListener("click", () => {
          this.rate = r;
          this.syncRates();
        });
        rateHost.appendChild(b);
        return { r, b };
      });
      this.syncRates();

      document.querySelectorAll("[data-program]").forEach((btn) => {
        btn.addEventListener("click", () => this.switchProgram(btn.dataset.program));
      });
      this.syncPrograms();
      this.syncToggle();
    }

    buildMintForm() {
      this.nameEl = $("#f-name");
      this.tickerEl = $("#f-ticker");
      this.cardEl = $("#chip-preview");
      if (!this.cardEl) return;

      // parametri economici del chip che si sta disegnando
      this.liqBps = 2000;
      this.spanSeconds = 7776000; // 90 giorni, come il chip #1

      document.querySelectorAll("[data-liq]").forEach((b) => {
        b.addEventListener("click", () => {
          this.liqBps = Number(b.dataset.liq);
          document.querySelectorAll("[data-liq]").forEach((x) =>
            x.classList.toggle("is-on", x === b));
          this.drawEmission();
        });
      });
      document.querySelectorAll("[data-span]").forEach((b) => {
        b.addEventListener("click", () => {
          this.spanSeconds = Number(b.dataset.span);
          document.querySelectorAll("[data-span]").forEach((x) =>
            x.classList.toggle("is-on", x === b));
          this.drawEmission();
        });
      });
      this.drawEmission();
      this.buildUpload();
      this.buildPair();

      // il byte in ingresso: quello che uno sponsor passerebbe a tick()
      const inEl = $("#f-inbyte");
      if (inEl) {
        const apply = () => {
          const v = Math.max(0, Math.min(255, Number(inEl.value) || 0));
          this.machine.inPort = v;
        };
        inEl.addEventListener("input", apply);
        apply();
      }

      const onInput = () => {
        // il ticker si normalizza mentre scrivi, come lo vuole il contratto
        const cleaned = safeTicker(this.tickerEl.value);
        if (cleaned !== this.tickerEl.value) this.tickerEl.value = cleaned;
        const note = $("#f-ticker-note");
        if (cleaned.length === 0) {
          note.textContent = "a chip needs a ticker";
          note.classList.add("is-bad");
        } else {
          note.textContent = "unique across the factory";
          note.classList.remove("is-bad");
        }
        this.cardKey = null; // forza il ridisegno
        this.drawEmission();
      };

      this.nameEl.addEventListener("input", () => { this.cardKey = null; });
      this.tickerEl.addEventListener("input", onInput);

      // scegliere il programma qui cambia anche quello che gira sopra:
      // cosi' l'anteprima mostra davvero il chip che si sta per coniare
      this.mintProg = "echo";
      document.querySelectorAll("[data-mintprog]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.mintProg = btn.dataset.mintprog;
          this.switchProgram(btn.dataset.mintprog);
        });
      });

      this.buildMint();
    }

    // ---- il conio vero: dal form alla fabbrica ---------------------------

    mintSay(msg, bad) {
      const el = $("#f-mint-note");
      if (!el) return;
      el.hidden = !msg;
      el.textContent = msg || "";
      el.classList.toggle("is-bad", Boolean(bad));
    }

    /** bytes32 da una stringa: UTF-8, allineata a sinistra, max 32 byte. */
    static b32(s) {
      const bytes = new TextEncoder().encode(s);
      if (bytes.length === 0 || bytes.length > 32) return null;
      let hex = "";
      for (const b of bytes) hex += b.toString(16).padStart(2, "0");
      return hex.padEnd(64, "0");
    }

    /**
     * La calldata di mint(), scritta a mano come quella di tick(): l'array
     * da 128 slot e' a dimensione fissa, quindi vive in testa; l'unico
     * campo dinamico e' il logo, in coda dopo 133 parole (offset 0x10a0).
     */
    encodeMint(slots, labelHex, tickerHex, logoURI, liqBps, targetCycles) {
      const word = (v) => BigInt(v).toString(16).padStart(64, "0");
      let head = "";
      for (const s of slots) head += word(s);
      head += labelHex + tickerHex + word(133 * 32) + word(liqBps) + word(targetCycles);

      const logoBytes = new TextEncoder().encode(logoURI);
      let tail = word(logoBytes.length);
      let hex = "";
      for (const b of logoBytes) hex += b.toString(16).padStart(2, "0");
      tail += hex.padEnd(Math.ceil(hex.length / 64) * 64 || 0, "0");

      return SELECTOR_MINT + head + tail;
    }

    async rpc(method, params) {
      const res = await fetch(CFG().rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "rpc error");
      return data.result;
    }

    /** La sigla e' unica per sempre: si controlla mentre scrivi, non al conio. */
    async checkTickerFree(ticker) {
      const hex = UI.b32(ticker);
      if (!hex) return false;
      const result = await this.rpc("eth_call", [
        { to: CFG().factory, data: SELECTOR_BYTICKER + hex }, "latest",
      ]);
      return BigInt(result || "0x0") === 0n;
    }

    buildMint() {
      const btn = $("#f-mint");
      // launchpadOpen apre a tutti; il localStorage apre solo a chi lo
      // imposta nel proprio browser — serve per collaudare sul sito vero
      // prima del flip. Non e' un segreto: la fabbrica e' gia' permissionless.
      let preview = false;
      try { preview = localStorage.getItem("rh4_launchpad") === "open"; } catch (_) {}
      if (!btn || (!CFG().launchpadOpen && !preview) || !window.RH4_PROGRAMS) return;

      btn.disabled = false;
      btn.textContent = "MINT — LAUNCH CHIP & TOKEN";

      // disponibilita' della sigla, con calma: mezzo secondo dopo l'ultimo tasto
      let debounce;
      this.tickerEl.addEventListener("input", () => {
        clearTimeout(debounce);
        const t = safeTicker(this.tickerEl.value);
        if (!t) return;
        debounce = setTimeout(async () => {
          try {
            const free = await this.checkTickerFree(t);
            const note = $("#f-ticker-note");
            note.textContent = free ? `${t} is free` : `${t} is taken — forever`;
            note.classList.toggle("is-bad", !free);
          } catch (_) { /* la rete puo' tossire: il conio ricontrolla comunque */ }
        }, 500);
      });

      btn.addEventListener("click", () => this.walletMint(btn));
    }

    async walletMint(btn) {
      const provider = window.ethereum;
      if (!provider) { this.mintSay("no wallet found in this browser", true); return; }

      const name = this.nameEl.value.trim();
      const ticker = safeTicker(this.tickerEl.value);
      const labelHex = UI.b32(name);
      const tickerHex = UI.b32(ticker);
      if (!labelHex) { this.mintSay("the name must be 1–32 bytes", true); return; }
      if (!tickerHex || !ticker) { this.mintSay("a chip needs a ticker", true); return; }
      const logo = this.logoURI || "";
      if (logo && !/^(https:\/\/|ipfs:\/\/)[\x20-\x21\x23-\x5b\x5d-\x7e]{1,190}$/.test(logo)) {
        this.mintSay("logo URI must be https:// or ipfs://", true); return;
      }

      const prog = (window.RH4_PROGRAMS[this.mintProg] || window.RH4_PROGRAMS.echo);
      const targetCycles = this.spanSeconds * 10; // un ciclo per blocco a 10 Hz
      const data = this.encodeMint(prog.slots, labelHex, tickerHex, logo, this.liqBps, targetCycles);

      btn.disabled = true;
      try {
        // il wallet, sulla chain giusta
        const [account] = await provider.request({ method: "eth_requestAccounts" });
        try {
          await provider.request({ method: "wallet_switchEthereumChain",
            params: [{ chainId: CFG().chainIdHex }] });
        } catch (e) {
          if (e && e.code === 4902) {
            await provider.request({ method: "wallet_addEthereumChain", params: [{
              chainId: CFG().chainIdHex, chainName: CFG().chainName,
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [CFG().rpc], blockExplorerUrls: [CFG().explorer],
            }] });
          } else throw e;
        }

        // prova generale via eth_call: se il conio fallirebbe, si scopre
        // qui, gratis — non dopo la firma
        this.mintSay("checking the mint…");
        await this.rpc("eth_call", [{ from: account, to: CFG().factory, data }, "latest"]);

        this.mintSay("confirm in your wallet…");
        const hash = await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: CFG().factory, data }],
        });

        this.mintSay(`sent — ${hash.slice(0, 10)}… waiting for the chain`);
        let receipt = null;
        for (let i = 0; i < 60 && !receipt; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          receipt = await this.rpc("eth_getTransactionReceipt", [hash]);
        }
        if (!receipt) throw new Error("still pending — check the explorer");
        if (receipt.status !== "0x1") throw new Error("the mint reverted");

        const minted = (receipt.logs || []).find((l) => l.topics && l.topics[0] === TOPIC_MINTED);
        const id = minted ? Number(BigInt(minted.topics[1])) : null;
        btn.textContent = id ? `CHIP #${id} MINTED ✓` : "CHIP MINTED ✓";
        btn.style.background = "var(--mint-deep)";
        this.mintSay(`${name} (${ticker}) is alive — its token exists, its clock is waiting. ` +
          `See it: ${CFG().explorer}/tx/${hash}`);
      } catch (e) {
        this.mintSay(short(e), true);
        btn.disabled = false;
      }
    }

    /**
     * I conti dell'emissione, fatti in chiaro. Il numero che conta e' il
     * pareggio: sotto quella capitalizzazione un tick costa piu' di quanto
     * rende, e il chip si ferma. Non e' una minaccia, e' il meccanismo.
     */
    drawEmission() {
      const host = $("#f-emission");
      if (!host) return;

      const SUPPLY = 1e9;
      const GAS_PER_TICK = 256740;
      // il gas della chain si muove: appena la pagina lo legge, il numero
      // vero rimpiazza il ricordo (window.RH4_GWEI, vedi sotto)
      const GWEI = window.RH4_GWEI || 0.020166;
      const ethPerTick = GAS_PER_TICK * GWEI * 1e-9;

      const cycles = this.spanSeconds * 10;   // un ciclo per blocco, 10 Hz
      const reserve = SUPPLY * (1 - this.liqBps / 10000);
      const perCycle = reserve / cycles;
      const breakEvenMcap = ethPerTick * (SUPPLY / perCycle);

      const fmt = (n) => n >= 1
        ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
        : n.toPrecision(3);

      host.innerHTML =
        `<div class="em-row"><span>To liquidity</span><span>${fmt(SUPPLY - reserve)} ${this.tickerEl.value || "TOKENS"}</span></div>` +
        `<div class="em-row"><span>Earned by cycles</span><span>${fmt(reserve)} ${this.tickerEl.value || "TOKENS"}</span></div>` +
        `<div class="em-row"><span>Per clock cycle</span><span>${fmt(perCycle)}</span></div>` +
        `<div class="em-row"><span>Cost of one tick</span><span>${ethPerTick.toPrecision(3)} ETH</span></div>` +
        `<div class="em-row"><span>Trades against</span><span>${(PAIRS[this.pair || "weth"] || PAIRS.weth).label}</span></div>` +
        `<div class="em-break">Ticking pays for itself once the token is worth about ` +
        `<b>${fmt(breakEvenMcap)} ETH</b> fully diluted. Below that the chip stalls ` +
        `until someone thinks it is worth running.</div>`;
    }

    /**
     * Il caricamento del logo.
     *
     * Il contratto salva un URI, non l'immagine: il file va prima su IPFS e
     * solo dopo l'URI entra nella mint. Il pinning passa da una funzione
     * server perche' la chiave di Pinata nel browser non puo' stare —
     * chiunque la userebbe per riempire l'account di qualcun altro.
     */
    buildUpload() {
      const drop = $("#f-drop");
      const input = $("#f-file");
      const thumb = $("#f-thumb");
      const text = $("#f-drop-text");
      const note = $("#f-logo-note");
      if (!drop) return;

      this.logoURI = "";

      const say = (msg, state) => {
        note.textContent = msg;
        note.classList.toggle("is-bad", state === "bad");
        note.classList.toggle("is-busy", state === "busy");
      };

      const accept = async (file) => {
        if (!file) return;
        if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
          return say("only PNG, JPEG, GIF or WebP — SVG can carry scripts", "bad");
        }
        if (file.size > 1024 * 1024) {
          return say(`${Math.round(file.size / 1024)} kB is over the 1 MB limit`, "bad");
        }

        // anteprima subito, senza aspettare la rete: se il file e' sbagliato
        // te ne accorgi prima di caricarlo
        thumb.src = URL.createObjectURL(file);
        thumb.hidden = false;
        text.hidden = true;
        drop.classList.add("is-set");
        this.cardKey = null;

        say("pinning to IPFS…", "busy");
        try {
          const body = new FormData();
          body.append("file", file);
          const res = await fetch(CFG().pinEndpoint || "/api/pin", { method: "POST", body });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          this.logoURI = data.uri;
          say(data.uri);
        } catch (e) {
          this.logoURI = "";
          say(`upload failed: ${e.message}`, "bad");
        }
      };

      drop.addEventListener("click", () => input.click());
      input.addEventListener("change", () => accept(input.files[0]));

      for (const ev of ["dragenter", "dragover"]) {
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.add("is-over");
        });
      }
      for (const ev of ["dragleave", "drop"]) {
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.remove("is-over");
        });
      }
      drop.addEventListener("drop", (e) => accept(e.dataTransfer?.files?.[0]));
    }

    /** Selettore della coppia. Non tocca la mint: informa il passo del pool. */
    buildPair() {
      const note = $("#f-pair-note");
      if (!note) return;
      this.pair = "weth";

      document.querySelectorAll("[data-pair]").forEach((b) => {
        b.addEventListener("click", () => {
          this.pair = b.dataset.pair;
          document.querySelectorAll("[data-pair]").forEach((x) =>
            x.classList.toggle("is-on", x === b));
          const p = PAIRS[this.pair];
          note.textContent = p.note;
          note.classList.toggle("is-bad", Boolean(p.bad));
          this.drawEmission();
        });
      });
    }

    switchProgram(name) {
      this.programName = name;
      const inPort = this.machine.inPort;
      this.machine = new Machine(D.programs[name]);
      this.machine.inPort = inPort;
      this.die.dirty = true;
      this.cardKey = null;
      this.buildListing();
      this.syncPrograms();
      this.render();
    }

    drawChipCard() {
      if (!this.cardEl) return;
      const m = this.machine;
      const name = safeName(this.nameEl.value) || "UNNAMED";
      const ticker = safeTicker(this.tickerEl.value);
      const key = [name, ticker, m.out(), m.cycle, m.pc(), m.halted()].join("|");
      if (key === this.cardKey) return;
      this.cardKey = key;

      this.cardEl.innerHTML = chipSvg({
        name,
        ticker,
        out: m.out(),
        cycles: m.cycle.toLocaleString("en-US"),
        pc: m.pc(),
        halted: m.halted(),
      });
    }

    syncToggle() {
      const b = $("#toggle");
      b.textContent = this.running ? "PAUSE" : "RUN";
      b.classList.toggle("chip-on", this.running);
    }

    syncRates() {
      for (const { r, b } of this.rateButtons) b.classList.toggle("is-on", r === this.rate);
    }

    syncPrograms() {
      document.querySelectorAll("[data-program]").forEach((btn) => {
        btn.classList.toggle("is-on", btn.dataset.program === this.programName);
      });
      document.querySelectorAll("[data-mintprog]").forEach((btn) => {
        btn.classList.toggle("is-on", btn.dataset.mintprog === this.programName);
      });
      const note = $("#f-prog-note");
      if (note) {
        note.textContent = this.programName === "echo8"
          ? "listens forever — echoes your byte and keeps the running sum in RAM"
          : "the self-test: halts after 15 cycles — the chip would stop for good";
        note.classList.toggle("is-bad", this.programName !== "echo8");
      }
    }

    // ---- frame

    loop(now) {
      const dt = Math.min(now - this.last, 250);
      this.last = now;

      const m = this.machine;
      if (this.running && !m.halted()) {
        this.acc += (dt / 1000) * this.rate.hz;
        let budget = 64; // never let a backgrounded tab stampede
        while (this.acc >= 1 && budget-- > 0 && !m.halted()) {
          this.acc -= 1;
          m.tick();
        }
        if (this.acc > 4) this.acc = 0;
      }

      this.render();
      requestAnimationFrame(this.loop);
    }

    render() {
      const m = this.machine;
      this.die.draw(m);

      const out = m.out();
      for (let i = 0; i < 8; i++) {
        this.leds[i].classList.toggle("is-on", ((out >> i) & 1) === 1);
      }

      for (let r = 0; r < 16; r++) {
        const text = m.reg(r).toString(16).toUpperCase().padStart(2, "0");
        const { cell, val } = this.regCells[r];
        if (val.textContent !== text) {
          val.textContent = text;
          cell.classList.remove("just-changed");
          void cell.offsetWidth; // restart the flash
          cell.classList.add("just-changed");
        }
      }

      const pc = m.pc();
      if (pc !== this.shownPc) {
        const prev = this.lines.get(this.shownPc);
        if (prev) prev.classList.remove("is-pc");
        const cur = this.lines.get(pc);
        if (cur) {
          cur.classList.add("is-pc");
          this.followPc(cur);
        }
        this.shownPc = pc;
      }

      this.put("#v-cycle", m.cycle.toLocaleString("en-US"));
      this.put("#v-pc", hex3(pc));
      this.put("#v-out", String(out));
      this.put("#v-instr", disasm(m.lastInstr));
      this.put("#v-flags", `${m.carry() ? "C" : "·"}${m.zero() ? "Z" : "·"}`);
      this.put("#v-elapsed", (m.cycle / 10).toFixed(1) + " s");
      $("#v-halt").hidden = !m.halted();

      this.drawChipCard();
    }

    /**
     * The ROM window shows a dozen lines out of forty-two, so a jump can
     * take the program counter clean out of view. Only scroll when the line
     * has actually left the window — scrolling on every cycle would make the
     * listing shiver at 40 Hz.
     */
    followPc(line) {
      const host = this.listingHost;
      if (!host) return;
      const top = line.offsetTop;
      const bottom = top + line.offsetHeight;
      const viewTop = host.scrollTop;
      const viewBottom = viewTop + host.clientHeight;
      if (top >= viewTop && bottom <= viewBottom) return;
      host.scrollTop = top - host.clientHeight / 2 + line.offsetHeight / 2;
    }

    /** Writing textContent unconditionally at 60 fps dirties layout for free. */
    put(sel, text) {
      if (this.shown[sel] === text) return;
      this.shown[sel] = text;
      $(sel).textContent = text;
    }

    wallClock() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      $("#v-clock").textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  }

  // Facts that come straight from the netlist, so the page can never drift
  // from the hardware it describes.
  function stampFacts() {
    const map = {
      gates: D.gateCount.toLocaleString("en-US"),
      flops: String(D.flopCount),
      instructions: String(D.programs.echo8.listing.length),
    };
    document.querySelectorAll("[data-fact]").forEach((node) => {
      const v = map[node.dataset.fact];
      if (v !== undefined) node.textContent = v;
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    stampFacts();
    const ui = new UI();
    new Wallet(window.RH4_CONFIG || {});

    // il prezzo del gas, quello vero: il break-even del mining dipende
    // tutto da lui, e una costante invecchia male
    (async () => {
      try {
        const res = await fetch((window.RH4_CONFIG || {}).rpc, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
        });
        const data = await res.json();
        if (data.result) {
          window.RH4_GWEI = Number(BigInt(data.result)) / 1e9;
          if (ui && ui.drawEmission) ui.drawEmission();
        }
      } catch (_) {}
    })();
  });
})();
