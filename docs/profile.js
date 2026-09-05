/**
 * profile.js — il profilo di un wallet, letto dalla chain e basta.
 *
 * I chip che ha coniato o di cui possiede l'NFT; le fee maturate nei vault
 * (con CLAIM); le fee in attesa nelle posizioni LP (con SWEEP); i cicli
 * pagati e i token guadagnati (dagli eventi Rewarded); i token dei chip nel
 * wallet. Nessun backend: la fabbrica e i vault sono il database.
 */
(function () {
  "use strict";

  const CFG = () => window.RH4_CONFIG || {};
  const $ = (s) => document.querySelector(s);

  const S_TOTAL = "0x73514205", S_CHIP = "0x8c6aefcf", S_INSPECT = "0xb3e98ae8",
        S_OWNEROF = "0x6352211e", S_BAL = "0x70a08231", S_SYMBOL = "0x95d89b41",
        S_CLAIMABLE = "0xd4570c1c", S_CLAIMMANY = "0x7e686e01", S_COLLECT = "0xce3f865f",
        S_TOKBYIDX = "0x2f745c59", S_POSITIONS = "0x99fbab88";
  const TOPIC_REWARDED = "0x6d46424d7308d93179bbc5c8c01e098e8353dad13aff9809fd8a881a69feaa3a";
  const TOPIC_CLAIMED = "0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683";
  const NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
  const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
  const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
  const ZERO = "0x" + "0".repeat(40);

  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const addrWord = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  const w = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (e) => String((e && (e.message || e)) || "error").slice(0, 90);
  const fmt = (wei, d = 2) => (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: d });
  const fmtQ = (wei) => { const n = Number(wei) / 1e18; return n >= 1 ? n.toFixed(4) : n.toPrecision(4); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function b32ToString(hex) {
    const bytes = [];
    for (let i = 0; i < 64; i += 2) {
      const c = parseInt(hex.slice(i, i + 2), 16);
      if (c === 0) break;
      bytes.push(c);
    }
    try { return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes)).replace(/[\u0000-\u001f\u007f]/g, " "); }
    catch (_) { return ""; }
  }
  function decodeString(hex) {
    try {
      const len = Number(BigInt("0x" + w(hex, 1)));
      return decodeURIComponent(hex.slice(2 + 128, 2 + 128 + len * 2).replace(/(..)/g, "%$1"));
    } catch (_) { return "?"; }
  }

  async function rpc(method, params) {
    const res = await fetch(CFG().rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message || "rpc error");
    return d.result;
  }
  /** tante letture, una richiesta: gli errori dei singoli diventano null */
  async function rpcBatch(reqs) {
    const out = new Array(reqs.length).fill(null);
    for (let start = 0; start < reqs.length; start += 50) {  // a fette: il nodo pubblico ha un tetto
      const slice = reqs.slice(start, start + 50);
      try {
        const res = await fetch(CFG().rpc, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(slice.map((r, i) => ({ jsonrpc: "2.0", id: start + i, ...r }))) });
        const data = await res.json();
        const byId = new Map((Array.isArray(data) ? data : [data]).map((r) => [r.id, r]));
        for (let i = 0; i < slice.length; i++) { const r = byId.get(start + i); out[start + i] = r && !r.error ? r.result : null; }
      } catch (_) {}
    }
    return out;
  }
  const ecall = (to, data, from) => ({ method: "eth_call", params: [{ to, data, ...(from && { from }) }, "latest"] });

  /** getLogs a fette dal genesis, tutte in un batch */
  async function logsSince(address, topics) {
    const now = Number(BigInt(await rpc("eth_blockNumber", [])));
    const from0 = CFG().genesisBlock || 1, CH = 500000;
    const reqs = [];
    for (let from = from0; from <= now; from += CH) {
      reqs.push({ method: "eth_getLogs", params: [{ address, topics, fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + Math.min(from + CH - 1, now).toString(16) }] });
    }
    const parts = await rpcBatch(reqs);
    return parts.flatMap((p) => p || []);
  }

  // ------------------------------------------------------------- il profilo

  const state = { me: null, chips: [], symbols: new Map(), seq: 0 };

  async function symbolOf(token) {
    if (!state.symbols.has(token.toLowerCase())) {
      const hex = await rpc("eth_call", [{ to: token, data: S_SYMBOL }, "latest"]).catch(() => null);
      state.symbols.set(token.toLowerCase(), hex && hex.length > 2 ? decodeString(hex) : "?");
    }
    return state.symbols.get(token.toLowerCase());
  }

  async function load(me) {
    const seq = ++state.seq;
    state.me = me;
    $("#pf-addr").textContent = me;
    $("#pf-empty").hidden = true;
    $("#pf-body").hidden = false;
    const F = CFG().factory;

    // 1. tutti i chip della fabbrica: struct, proprietario, stato — un batch
    const total = Number(BigInt(await rpc("eth_call", [{ to: F, data: S_TOTAL }, "latest"])));
    const ids = Array.from({ length: total }, (_, i) => i + 1);
    const nowBlock = BigInt(await rpc("eth_blockNumber", []));
    const res = await rpcBatch(ids.flatMap((id) => [
      ecall(F, S_CHIP + word(id)), ecall(F, S_OWNEROF + word(id)), ecall(F, S_INSPECT + word(id)),
    ]));
    const chips = ids.map((id, k) => {
      const c = res[k * 3], o = res[k * 3 + 1], s = res[k * 3 + 2];
      if (!c) return null;
      const ins = s ? {
        pc: Number(BigInt("0x" + w(s, 0))), out: Number(BigInt("0x" + w(s, 1))),
        halted: BigInt("0x" + w(s, 2)) === 1n, cycles: Number(BigInt("0x" + w(s, 3))),
        behind: Number(nowBlock - BigInt("0x" + w(s, 4))),
      } : null;
      return {
        id, label: b32ToString(w(c, 1)), ticker: b32ToString(w(c, 2)),
        minter: "0x" + w(c, 3).slice(24), token: "0x" + w(c, 6).slice(24),
        owner: o ? "0x" + w(o, 0).slice(24) : ZERO, ins,
      };
    }).filter(Boolean);
    if (seq !== state.seq) return; // nel frattempo e' partito un caricamento piu' nuovo
    state.chips = chips;
    const mine = chips.filter((c) => c.minter.toLowerCase() === me.toLowerCase() || c.owner.toLowerCase() === me.toLowerCase());
    for (const c of chips) if (c.token !== ZERO) state.symbols.set(c.token.toLowerCase(), c.ticker || "?");

    renderChips(mine);
    await Promise.all([loadFees(mine), loadMining(), loadHoldings(chips)]);
    loadPending(mine).catch(() => {});
  }

  function renderChips(mine) {
    const host = $("#chips");
    host.innerHTML = "";
    $("#c-chips").textContent = `${mine.length} CHIP${mine.length === 1 ? "" : "S"}`;
    $("#chips-note").hidden = mine.length > 0;
    for (const c of mine) {
      const s = c.ins || { pc: 0, out: 0, halted: false, cycles: 0, behind: 0 };
      const badge = s.halted ? ["HALTED", "halt"] : s.behind > 36000 ? ["IDLE", "stall"] : ["RUNNING", "run"];
      const role = c.minter.toLowerCase() === state.me.toLowerCase() ? "CREATOR" : "HOLDER";
      const leds = Array.from({ length: 8 }, (_, i) => `<div class="gled${(s.out >> (7 - i)) & 1 ? " on" : ""}"></div>`).join("");
      const el = document.createElement("a");
      el.className = "gchip"; el.href = `chip.html?id=${c.id}`; el.dataset.id = c.id;
      el.innerHTML =
        `<div class="row1"><span class="tick">${esc(c.ticker || "?")}</span>` +
        `<span><span class="badge role">${role}</span> <span class="badge ${badge[1]}">${badge[0]}</span></span></div>` +
        `<div class="name">#${c.id} · ${esc(c.label || "unnamed")}</div>` +
        `<div class="gleds">${leds}</div>` +
        `<div class="grow"><span>CYCLES <b>${s.cycles.toLocaleString("en-US")}</b></span><span>OUT <b>${s.out}</b></span>` +
        `<span>PC <b>0x${s.pc.toString(16).padStart(3, "0")}</b></span></div>` +
        `<div class="pend" data-pend="${c.id}">market fees: reading&hellip;</div>`;
      host.appendChild(el);
    }
  }

  /** le posizioni LP dei miei chip nei vault: fee in attesa di sweep */
  async function loadPending(mine) {
    const vaults = [CFG().creatorVault, CFG().feeVault, ...(CFG().legacyVaults || [])].filter(Boolean);
    const byToken = new Map(mine.filter((c) => c.token !== ZERO).map((c) => [c.token.toLowerCase(), c]));
    const found = new Map(); // chipId -> {vault, tokenId, t0, t1}
    for (const vault of vaults) {
      const nHex = await rpc("eth_call", [{ to: NPM, data: S_BAL + addrWord(vault) }, "latest"]).catch(() => null);
      const n = nHex ? Number(BigInt(nHex)) : 0;
      if (!n) continue;
      const tidsRaw = await rpcBatch(Array.from({ length: Math.min(n, 60) }, (_, i) => ecall(NPM, S_TOKBYIDX + addrWord(vault) + word(i))));
      const tids = tidsRaw.filter(Boolean);
      const poss = await rpcBatch(tids.map((t) => ecall(NPM, S_POSITIONS + t.slice(2))));
      poss.forEach((p, i) => {
        if (!p) return;
        const t0 = "0x" + w(p, 2).slice(24), t1 = "0x" + w(p, 3).slice(24);
        const c = byToken.get(t0.toLowerCase()) || byToken.get(t1.toLowerCase());
        if (c && !found.has(c.id)) found.set(c.id, { vault, tokenId: BigInt(tids[i]), t0, t1 });
      });
    }
    for (const c of mine) {
      const el = document.querySelector(`[data-pend="${c.id}"]`);
      if (!el) continue;
      const f = found.get(c.id);
      if (!f) { el.textContent = c.token === ZERO ? "no token" : "market fees: no vaulted position (market not open, or LP burned)"; continue; }
      let a0 = 0n, a1 = 0n;
      try {
        const r = await rpc("eth_call", [{ from: state.me, to: f.vault, data: S_COLLECT + word(f.tokenId) }, "latest"]);
        a0 = BigInt("0x" + w(r, 0)); a1 = BigInt("0x" + w(r, 1));
      } catch (_) {}
      const s0 = await symbolOf(f.t0), s1 = await symbolOf(f.t1);
      const isLegacy = (CFG().legacyVaults || []).map((v) => v.toLowerCase()).includes(f.vault.toLowerCase());
      el.innerHTML = a0 === 0n && a1 === 0n
        ? `market fees waiting: <b>none yet</b>`
        : `market fees waiting: <b>${fmt(a0, 0)} ${esc(s0)}</b> + <b>${fmtQ(a1)} ${esc(s1)}</b>` +
          ` &middot; <button class="btn btn-light btn-sm" data-sweep="${f.vault}|${f.tokenId}" style="padding:4px 9px;font-size:10px">SWEEP</button>` +
          (isLegacy ? `<br><span style="opacity:.7">(first-generation vault: your half is paid at the sweep)</span>` : "");
      const b = el.querySelector("[data-sweep]");
      if (b) b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); sweep(b); });
    }
  }

  async function sweep(btn) {
    const [vault, tokenId] = btn.dataset.sweep.split("|");
    const provider = window.ethereum;
    if (!provider) return;
    btn.disabled = true; btn.textContent = "SWEEPING…";
    try {
      const h = await provider.request({ method: "eth_sendTransaction", params: [{ from: state.me, to: vault, data: S_COLLECT + word(tokenId) }] });
      let r = null;
      for (let i = 0; i < 40 && !r; i++) { await sleep(2500); r = await rpc("eth_getTransactionReceipt", [h]); }
      btn.textContent = r && r.status === "0x1" ? "SWEPT ✓" : "FAILED";
      if (r && r.status === "0x1") setTimeout(() => load(state.me), 1500);
    } catch (e) { btn.textContent = "SWEEP"; btn.disabled = false; }
  }

  /** fee maturate nei vault buyback (claimable) + storico dei claim */
  async function loadFees(mine) {
    const host = $("#fees");
    host.querySelectorAll(".prow:not(.h), .pf-empty-row").forEach((n) => n.remove());
    const vaults = [[CFG().creatorVault, "50/50"], [CFG().feeVault, "100%"]].filter((v) => v[0]);
    const tokens = [...new Set([...mine.map((c) => c.token).filter((t) => t !== ZERO), WETH, NVDA])];
    const reqs = [];
    for (const [vault] of vaults) for (const t of tokens) reqs.push(ecall(vault, S_CLAIMABLE + addrWord(state.me) + addrWord(t)));
    const res = await rpcBatch(reqs);

    // storico: Claimed(creator indexed, token indexed, amount)
    const claimed = new Map(); // vault|token -> sum
    for (const [vault] of vaults) {
      const logs = await logsSince(vault, [TOPIC_CLAIMED, "0x" + addrWord(state.me)]).catch(() => []);
      for (const l of logs) {
        const t = "0x" + l.topics[2].slice(26);
        const k = vault.toLowerCase() + "|" + t.toLowerCase();
        claimed.set(k, (claimed.get(k) || 0n) + BigInt(l.data.slice(0, 66)));
      }
    }

    let rows = 0, k = 0;
    const perVault = new Map();
    for (const [vault, label] of vaults) {
      for (const t of tokens) {
        const amt = res[k] ? BigInt(res[k]) : 0n; k++;
        const done = claimed.get(vault.toLowerCase() + "|" + t.toLowerCase()) || 0n;
        if (amt === 0n && done === 0n) continue;
        const sym = await symbolOf(t);
        const isQuote = t.toLowerCase() === WETH.toLowerCase() || t.toLowerCase() === NVDA.toLowerCase();
        const row = document.createElement("div");
        row.className = "prow fees";
        row.innerHTML =
          `<span><b>${esc(sym)}</b></span>` +
          `<span class="num">${isQuote ? fmtQ(amt) : fmt(amt, 0)}</span>` +
          `<span class="dim">${isQuote ? fmtQ(done) : fmt(done, 0)}</span>` +
          `<span class="sm">${label}</span>` +
          `<span></span>`;
        host.appendChild(row);
        rows++;
        if (amt > 0n) { if (!perVault.has(vault)) perVault.set(vault, []); perVault.get(vault).push(t); }
      }
    }
    for (const [vault, toks] of perVault) {
      const row = document.createElement("div");
      row.className = "prow fees";
      row.style.gridTemplateColumns = "1fr auto";
      row.innerHTML = `<span class="sm">${toks.length} token${toks.length > 1 ? "s" : ""} waiting in the ${vaults.find((v) => v[0] === vault)[1]} vault</span>` +
        `<button class="btn btn-dark btn-sm" data-claim="${vault}">CLAIM ALL</button>`;
      host.appendChild(row);
      row.querySelector("button").addEventListener("click", (e) => claim(e.target, vault, toks));
    }
    if (!rows) { const d = document.createElement("div"); d.className = "pf-empty-row"; d.textContent = "no fees yet — they accrue here at every sweep of your chips' markets."; host.appendChild(d); }
    $("#c-fees").textContent = perVault.size ? "CLAIMABLE" : rows ? "ALL CLAIMED" : "—";
  }

  async function claim(btn, vault, tokens) {
    const provider = window.ethereum;
    if (!provider) return;
    btn.disabled = true; btn.textContent = "CONFIRM IN WALLET…";
    try {
      // claimMany(address[]): offset, length, indirizzi
      const data = S_CLAIMMANY + word(32) + word(tokens.length) + tokens.map(addrWord).join("");
      const h = await provider.request({ method: "eth_sendTransaction", params: [{ from: state.me, to: vault, data }] });
      btn.textContent = "CLAIMING…";
      let r = null;
      for (let i = 0; i < 40 && !r; i++) { await sleep(2500); r = await rpc("eth_getTransactionReceipt", [h]); }
      btn.textContent = r && r.status === "0x1" ? "CLAIMED ✓" : "FAILED";
      if (r && r.status === "0x1") setTimeout(() => load(state.me), 1500);
    } catch (e) { btn.textContent = "CLAIM ALL"; btn.disabled = false; }
  }

  /** i cicli che ho pagato e cosa mi hanno reso: Rewarded(id, sponsor, amount) */
  async function loadMining() {
    const host = $("#mine");
    host.querySelectorAll(".prow:not(.h), .pf-empty-row").forEach((n) => n.remove());
    const logs = await logsSince(CFG().factory, [TOPIC_REWARDED, null, "0x" + addrWord(state.me)]).catch(() => []);
    const per = new Map();
    for (const l of logs) {
      const id = Number(BigInt(l.topics[1]));
      const cur = per.get(id) || { n: 0, amt: 0n };
      cur.n++; cur.amt += BigInt(l.data.slice(0, 66));
      per.set(id, cur);
    }
    let total = 0;
    for (const [id, v] of [...per.entries()].sort((a, b) => b[1].n - a[1].n)) {
      const c = state.chips.find((x) => x.id === id);
      const row = document.createElement("div");
      row.className = "prow mine";
      row.innerHTML = `<span><a href="chip.html?id=${id}">${esc(c ? c.ticker : "#" + id)}</a> <span class="sm">#${id}</span></span>` +
        `<span class="num">${v.n.toLocaleString("en-US")}</span><span class="num">${fmt(v.amt, 2)} ${esc(c ? c.ticker : "")}</span>`;
      host.appendChild(row);
      total += v.n;
    }
    if (!per.size) { const d = document.createElement("div"); d.className = "pf-empty-row"; d.textContent = "no cycles paid yet — power a chip from its page and the reward lands here."; host.appendChild(d); }
    $("#c-mine").textContent = total ? `${total.toLocaleString("en-US")} CYCLES` : "—";
  }

  /** i token dei chip nel wallet */
  async function loadHoldings(chips) {
    const host = $("#hold");
    host.querySelectorAll(".prow:not(.h), .pf-empty-row").forEach((n) => n.remove());
    const withToken = chips.filter((c) => c.token !== ZERO);
    const res = await rpcBatch(withToken.map((c) => ecall(c.token, S_BAL + addrWord(state.me))));
    let n = 0;
    withToken.forEach((c, i) => {
      const bal = res[i] ? BigInt(res[i]) : 0n;
      if (bal === 0n) return;
      n++;
      const pct = Number(bal / 10n ** 12n) / 1e6 / 1e9 * 100;
      const row = document.createElement("div");
      row.className = "prow hold";
      row.innerHTML = `<span><b>${esc(c.ticker)}</b> <span class="sm">${esc(c.label)}</span></span>` +
        `<span class="num">${fmt(bal, 0)}</span><span class="dim">${pct < 0.01 ? "<0.01" : pct.toFixed(2)}%</span>` +
        `<span><a class="btn btn-light btn-sm" href="chip.html?id=${c.id}">TRADE</a></span>`;
      host.appendChild(row);
    });
    if (!n) { const d = document.createElement("div"); d.className = "pf-empty-row"; d.textContent = "no chip tokens in this wallet."; host.appendChild(d); }
    $("#c-hold").textContent = n ? `${n} TOKEN${n === 1 ? "" : "S"}` : "—";
  }

  function reset() {
    state.me = null;
    $("#pf-addr").textContent = "not connected";
    $("#pf-empty").hidden = false;
    $("#pf-body").hidden = true;
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#pf-connect").addEventListener("click", () => window.RH4_WALLET && window.RH4_WALLET.connect());
    if (!window.RH4_WALLET) return;
    window.RH4_WALLET.onChange((addr) => {
      if (addr) load(addr).catch((e) => { $("#pf-addr").textContent = short(e); });
      else reset();
    });
  });
})();
