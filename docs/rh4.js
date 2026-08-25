/**
 * rh4.js — the RH-4, running in your browser.
 *
 * This is not an animation of a processor. It is the processor: the same
 * netlist the contract evaluates on-chain, 1,029 NAND gates in topological
 * order, flip-flops latching together at the end of every cycle.
 */
(function () {
  "use strict";

  const D = window.RH4_DATA;

  // ---------------------------------------------------------------- machine

  class Machine {
    constructor(program) {
      this.program = program;
      this.nets = new Uint8Array(D.nets);
      this.next = new Uint8Array(D.flopCount);
      this.heat = new Float32Array(D.gateCount);
      this.reset();
    }

    reset() {
      this.nets.fill(0);
      this.nets[D.one] = 1;
      this.heat.fill(0);
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

    /** One clock tick. On-chain this is one block. */
    tick() {
      const v = this.nets;
      const word = this.program.rom[this.pc()] || 0;
      for (let i = 0; i < 12; i++) v[D.instr[i]] = (word >> i) & 1;

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

      this.cycle++;
      this.lastInstr = word;
      return word;
    }
  }

  // ------------------------------------------------------------- disassembly

  const MNEMONIC = [
    "nop", "ldi", "mov", "add", "adc", "sub", "nand", "xor",
    "shr", "inc", "jmp", "jz", "jc", "jnz", "out", "hlt",
  ];
  const hex2 = (n) => "0x" + n.toString(16).padStart(2, "0");
  const FORM = {
    0: () => "",
    1: (d, s) => `r${d}, #${s}`,
    2: (d, s) => `r${d}, r${s}`,
    3: (d, s) => `r${d}, r${s}`,
    4: (d, s) => `r${d}, r${s}`,
    5: (d, s) => `r${d}, r${s}`,
    6: (d, s) => `r${d}, r${s}`,
    7: (d, s) => `r${d}, r${s}`,
    8: (d) => `r${d}`,
    9: (d) => `r${d}`,
    10: (d, s) => hex2((d << 4) | s),
    11: (d, s) => hex2((d << 4) | s),
    12: (d, s) => hex2((d << 4) | s),
    13: (d, s) => hex2((d << 4) | s),
    14: (d) => `r${d}`,
    15: () => "",
  };

  function disasm(word) {
    const op = (word >> 8) & 0xf;
    return `${MNEMONIC[op]} ${FORM[op]((word >> 4) & 0xf, word & 0xf)}`.trim();
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

      // keep the cells roughly square and legible whatever the panel width
      this.cols = Math.max(24, Math.min(56, Math.round(w / 13)));
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

  // --------------------------------------------------------------------- ui

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const RATES = [
    { hz: 10, label: "10 HZ", note: "one tick per block" },
    { hz: 40, label: "40 HZ", note: "4× fast-forward" },
    { hz: 2,  label: "2 HZ",  note: "slow" },
  ];

  class UI {
    constructor() {
      this.programName = "forever";
      this.machine = new Machine(D.programs.forever);
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

      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
      setInterval(() => this.wallClock(), 1000);
      this.wallClock();
    }

    // ---- construction

    buildLeds() {
      this.leds = [];
      const host = $("#leds");
      for (let i = 3; i >= 0; i--) {
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
        btn.addEventListener("click", () => {
          this.programName = btn.dataset.program;
          this.machine = new Machine(D.programs[this.programName]);
          this.die.dirty = true;
          this.buildListing();
          this.syncPrograms();
          this.render();
        });
      });
      this.syncPrograms();
      this.syncToggle();
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
      for (let i = 0; i < 4; i++) {
        this.leds[i].classList.toggle("is-on", ((out >> i) & 1) === 1);
      }

      for (let r = 0; r < 16; r++) {
        const text = m.reg(r).toString(16).toUpperCase();
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
      this.put("#v-pc", hex2(pc));
      this.put("#v-out", String(out));
      this.put("#v-instr", disasm(m.lastInstr));
      this.put("#v-flags", `${m.carry() ? "C" : "·"}${m.zero() ? "Z" : "·"}`);
      this.put("#v-elapsed", (m.cycle / 10).toFixed(1) + " s");
      $("#v-halt").hidden = !m.halted();
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
      instructions: String(D.programs.forever.listing.length),
    };
    document.querySelectorAll("[data-fact]").forEach((node) => {
      const v = map[node.dataset.fact];
      if (v !== undefined) node.textContent = v;
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    stampFacts();
    new UI();
  });
})();
