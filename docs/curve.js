/**
 * curve.js — il launchpad a curva (RH4Curve), pagina nascosta.
 *
 * Nessun link porta qui. Il cancello e' config.js: `curve.enabled` con gli
 * indirizzi accende form e trade; senza, la pagina e' una porta chiusa, e con
 * `?preview` nell'URL si vede in sola lettura (con un address, legge i lanci
 * veri). Tutto via eth_call sul nodo pubblico, niente backend, niente chiavi:
 * le firme le mette il wallet del browser.
 */
(function () {
  "use strict";

  const CFG = () => window.RH4_CONFIG || {};
  const CV = () => CFG().curve || {};
  const $ = (s) => document.querySelector(s);

  // ---- il contratto, in selettori ------------------------------------------
  const S = {
    launch: "0xcae84398",     // launch(string,string,address,uint256,uint16)
    buy: "0xa59ac6dd",        // buy(address,uint256,uint256)
    sell: "0x6a272462",       // sell(address,uint256,uint256)
    quoteBuy: "0x0d7a94f6",   // quoteBuy(address,uint256) -> (tokensOut, fee)
    quoteSell: "0xd98b2f5c",  // quoteSell(address,uint256) -> (quoteOut, fee)
    price: "0xaea91078",      // price(address)
    count: "0x06661abd",      // count()
    tokens: "0x4f64b2be",     // tokens(uint256)
    launches: "0x1f2d8550",   // launches(address) -> 12 parole
    quoteAllowed: "0x1928f54e",
    minThreshold: "0x3ea40339",
    claimable: "0xd4570c1c",  // vault: claimable(creator, asset)
    claim: "0x1e83409a",      // vault: claim(asset)
    name: "0x06fdde03", symbol: "0x95d89b41", balanceOf: "0x70a08231",
    allowance: "0xdd62ed3e", approve: "0x095ea7b3", slot0: "0x3850c7bd",
  };
  const TOPIC_LAUNCHED = "0xc25b97abc78a6e03dfb4e180bb1f6d71b901066261cad904c65fba5a70fb3280";
  const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
  const SUPPLY = 10n ** 27n;
  const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;
  const LP_SUPPLY = 200_000_000n * 10n ** 18n;
  const VIRTUAL_TOKENS = 1_073_000_000n * 10n ** 18n;
  const MAX_EARLY_BUY = 20_000_000n * 10n ** 18n;

  const ERRORS = {
    "0xd500448a": "this pair is not open on the curve", "0x398ecf8a": "target too low for this pair",
    "0x47de24a8": "fee split must be 50% or 0%", "0x0cf64598": "no such launch",
    "0xe6a0d45f": "the curve is full: trade in the market now", "0x5c52a868": "nothing to do",
    "0xe20a4c5d": "the curve moved past the slippage floor — try again",
    "0x85576e12": "the first 100 blocks cap every buy at 2% of the supply",
    "0x0275b7e1": "locked until the curve fills", "0x30cd7471": "not the owner",
  };

  // ---- rpc ------------------------------------------------------------------
  const word = (v) => { let b = BigInt(v); if (b < 0n) b += 1n << 256n; return b.toString(16).padStart(64, "0"); };
  const addrWord = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  const addrAt = (hex, i) => "0x" + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
  const wordAt = (hex, i) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  const short = (e) => String((e && (e.message || e)) || "error").slice(0, 110);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function explain(err) {
    const data = err && (err.data || (err.error && err.error.data));
    const hex = typeof data === "string" ? data : data && data.data;
    if (typeof hex === "string" && ERRORS[hex.slice(0, 10)]) return ERRORS[hex.slice(0, 10)];
    return (err && err.message) || "rpc error";
  }
  async function rpc(method, params, tries = 4) {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(CFG().rpc, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const data = await res.json();
        if (data.error) { const e = new Error(explain(data.error)); e.revert = true; throw e; }
        return data.result;
      } catch (e) {
        if (e.revert || i >= tries - 1) throw e;
        await sleep(600 * (i + 1));
      }
    }
  }
  async function rpcBatch(reqs) {
    const out = new Array(reqs.length);
    for (let start = 0; start < reqs.length; start += 50) {
      const slice = reqs.slice(start, start + 50);
      const res = await fetch(CFG().rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(slice.map((r, i) => ({ jsonrpc: "2.0", id: start + i, ...r }))) });
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [data];
      const byId = new Map(arr.map((r) => [r.id, r]));
      for (let i = 0; i < slice.length; i++) {
        const r = byId.get(start + i);
        if (!r || r.error) throw new Error((r && r.error && r.error.message) || "batch error");
        out[start + i] = r.result;
      }
    }
    return out;
  }
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
  const ecall = (to, data) => ({ method: "eth_call", params: [{ to, data }, "latest"] });
  const curveCall = (data) => call(CV().address, data);

  // ---- le quote ---------------------------------------------------------------
  const QUOTES = () => (CFG().quotes || []).filter((q) => q.enabled !== false);
  const quoteByKey = (k) => k === "weth" ? { sym: "WETH", name: "ether", address: WETH, decimals: 18 }
    : QUOTES().find((q) => q.sym.toLowerCase() === k) || null;
  const quoteByAddr = (a) => String(a).toLowerCase() === WETH.toLowerCase() ? quoteByKey("weth")
    : (CFG().quotes || []).find((q) => q.address.toLowerCase() === String(a).toLowerCase()) || { sym: "?", address: a, decimals: 18 };
  const decOf = (q) => q && q.decimals ? q.decimals : 18;

  // numeri: unita' grezze <-> testo, senza float
  function toUnits(str, dec) {
    const m = String(str).trim().replace(",", ".").match(/^(\d*)(?:\.(\d*))?$/);
    if (!m || (!m[1] && !m[2])) return null;
    const frac = (m[2] || "").slice(0, dec).padEnd(dec, "0");
    return BigInt(m[1] || "0") * 10n ** BigInt(dec) + BigInt(frac || "0");
  }
  function fmtUnits(bi, dec, digits) {
    const n = Number(bi) / 10 ** dec;
    if (n === 0) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: digits == null ? 4 : digits });
    if (n >= 1e-6) return n.toFixed(Math.min(12, 2 - Math.floor(Math.log10(n))));
    return n.toPrecision(3);
  }
  const fmtNum = (n) => n >= 1e3 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toPrecision(3);
  const fmtUsd = (n) => n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" : "$" + Math.round(n);

  // ETH in dollari, dal pool USDG/WETH (6 decimali contro 18)
  let ethUsdCache = 0;
  async function ethUsd() {
    if (ethUsdCache) return ethUsdCache;
    try {
      const s0 = await call("0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca", S.slot0);
      const sqrt = Number(wordAt(s0, 0)) / 2 ** 96;
      const usdgIs0 = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168".toLowerCase() < WETH.toLowerCase();
      const raw = sqrt * sqrt;                       // token1 per token0, unita' grezze
      ethUsdCache = usdgIs0 ? (1 / raw) * 1e12 : raw * 1e12;
    } catch (_) {}
    return ethUsdCache;
  }

  // ---- il cancello --------------------------------------------------------------
  // `?dev` accende tutto anche con enabled: false: la porta resta chiusa per il
  // sito, ma chi conosce l'URL prova lanci e trade veri
  const DEV = /[?&]dev\b/.test(location.search);
  const LIVE = Boolean(CV().address && (CV().enabled || DEV));
  const PREVIEW = /[?&]preview/.test(location.search);
  const READABLE = Boolean(CV().address);

  function gate() {
    if (LIVE) {
      if (!CV().enabled) { const b = $("#cv-banner"); b.hidden = false; b.innerHTML = `<b>DEV</b> &mdash; live for you, closed for everyone else. Real chain, real ETH.`; }
      return true;
    }
    if (!PREVIEW) {
      $("#cv-main").innerHTML =
        `<div class="cv-closed"><p class="pill"><span class="pill-n">FACTORY</span>THE CURVE</p>` +
        `<h2>This door isn&rsquo;t open yet.</h2>` +
        `<p>The bonding-curve launchpad is built and tested, not live. ` +
        `Until then, the <a href="launchpad.html">chip launchpad</a> is where tokens are born.</p></div>`;
      return false;
    }
    const b = $("#cv-banner");
    b.hidden = false;
    b.innerHTML = READABLE
      ? `<b>PREVIEW</b> &mdash; reading the curve at ${esc(CV().address)}, launches and trades are off`
      : `<b>PREVIEW</b> &mdash; no contract deployed: the form is a mock-up, the list stays empty`;
    return true;
  }

  // ---- il form ---------------------------------------------------------------------
  const st = { pair: "weth", bps: 5000, min: {} };
  const PRESETS = { weth: ["1", "2", "4.2", "10"], usdg: ["2500", "5000", "10000", "25000"] };

  function buildPairs() {
    const host = $("#c-pair");
    for (const q of QUOTES()) {
      const b = document.createElement("button");
      b.className = "chip"; b.dataset.pair = q.sym.toLowerCase(); b.textContent = q.sym; b.title = q.name;
      host.appendChild(b);
    }
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pair]"); if (!b) return;
      host.querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-on", c === b));
      st.pair = b.dataset.pair;
      drawPresets(); drawNote();
    });
  }

  function drawPresets() {
    const q = quoteByKey(st.pair);
    const host = $("#c-thr-presets");
    const list = PRESETS[st.pair] || ["10", "25", "50", "100"];
    host.innerHTML = list.map((v, i) => `<button class="chip${i === 2 ? " is-on" : ""}" data-thr="${v}">${v}</button>`).join("");
    $("#c-thr").value = list[2];
    $("#c-thr-unit").textContent = q ? q.sym : "";
    $("#c-thr-note").textContent = "…";
    const min = st.min[st.pair];
    if (min != null) $("#c-thr-note").textContent = min === 0n ? "this pair is not open on the curve yet"
      : `at least ${fmtUnits(min, decOf(q))} ${q.sym} for this pair`;
  }
  $("#c-thr-presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-thr]"); if (!b) return;
    $("#c-thr-presets").querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-on", c === b));
    $("#c-thr").value = b.dataset.thr; drawNote();
  });
  $("#c-thr").addEventListener("input", () => {
    $("#c-thr-presets").querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-on", c.dataset.thr === $("#c-thr").value.trim()));
    drawNote();
  });
  $("#c-fee").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bps]"); if (!b) return;
    $("#c-fee").querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-on", c === b));
    st.bps = Number(b.dataset.bps);
  });

  // la nota: dove parte e dove gradua, in quota e in dollari (se e' WETH)
  async function drawNote() {
    const q = quoteByKey(st.pair);
    const el = $("#c-note-fdv");
    const t = Number(String($("#c-thr").value).replace(",", "."));
    if (!q || !(t > 0)) { el.textContent = ""; return; }
    // FDV iniziale = Vq0 / Vt * 1B = (T*30/85) / 1.073 ; a fine curva 200M vs ~1.034 T -> FDV ~ 5.17 T
    const start = t * 30 / 85 / 1.073, end = t * 1.034 * 5;
    let usd = "";
    if (st.pair === "weth") { const p = await ethUsd(); if (p) usd = ` (about ${fmtUsd(start * p)} to ${fmtUsd(end * p)})`; }
    el.innerHTML = `The price starts at an FDV of <b>${fmtNum(start)} ${q.sym}</b> and the market opens at about <b>${fmtNum(end)} ${q.sym}</b>${esc(usd)}.`;
  }

  async function loadMins() {
    if (!READABLE) return;
    const keys = ["weth", ...QUOTES().map((q) => q.sym.toLowerCase())];
    try {
      const res = await rpcBatch(keys.flatMap((k) => { const q = quoteByKey(k); return [
        ecall(CV().address, S.quoteAllowed + addrWord(q.address)), ecall(CV().address, S.minThreshold + addrWord(q.address)) ]; }));
      keys.forEach((k, i) => { st.min[k] = wordAt(res[i * 2], 0) === 1n ? wordAt(res[i * 2 + 1], 0) : 0n; });
      // i pair chiusi sul contratto si spengono nel form
      $("#c-pair").querySelectorAll("[data-pair]").forEach((b) => { if (st.min[b.dataset.pair] === 0n) { b.classList.add("is-soon"); b.title = "not open on the curve"; } });
      drawPresets();
    } catch (_) {}
  }

  function say(msg, bad) {
    const el = $("#c-launch-note");
    if (el) { el.hidden = !msg; el.textContent = msg || ""; el.classList.toggle("is-bad", Boolean(bad)); }
  }

  // ABI: (string,string,address,uint256,uint16)
  function encLaunch(name, symbol, quote, threshold, bps) {
    const str = (s) => { const b = Array.from(new TextEncoder().encode(s), (x) => x.toString(16).padStart(2, "0")).join("");
      return word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, "0"); };
    const n = str(name), s = str(symbol);
    return S.launch + word(160) + word(160 + n.length / 2) + addrWord(quote) + word(threshold) + word(bps) + n + s;
  }

  async function ensureChain(provider) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG().chainIdHex }] });
    } catch (e) {
      const code = e && (e.code === 4902 ? 4902 : e.data && e.data.originalError && e.data.originalError.code);
      if (code === 4902) {
        await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: CFG().chainIdHex, chainName: CFG().chainName,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [CFG().rpc], blockExplorerUrls: [CFG().explorer] }] });
      } else throw e;
    }
  }
  async function waitReceipt(hash, rounds = 60) {
    let r = null;
    for (let i = 0; i < rounds && !r; i++) { await sleep(2500); r = await rpc("eth_getTransactionReceipt", [hash]); }
    if (!r) throw new Error("still pending — check the explorer");
    if (r.status !== "0x1") throw new Error("the transaction reverted");
    return r;
  }
  async function sendTx(provider, tx, label, status) {
    status(`${label}: confirm in your wallet…`);
    const hash = await provider.request({ method: "eth_sendTransaction", params: [tx] });
    status(`${label}: sent — ${hash.slice(0, 10)}… waiting for the chain`);
    return { hash, receipt: await waitReceipt(hash) };
  }
  // approve solo se serve, poi la call vera
  async function approveIf(provider, account, token, spender, amount, status) {
    const allowance = wordAt(await call(token, S.allowance + addrWord(account) + addrWord(spender)), 0);
    if (allowance >= amount) return;
    await sendTx(provider, { from: account, to: token, data: S.approve + addrWord(spender) + word(amount) }, "1/2 approve", status);
  }

  async function launch() {
    const provider = window.ethereum;
    if (!provider) { say("no wallet found in this browser", true); return; }
    const name = $("#c-name").value.trim();
    const ticker = $("#c-ticker").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    const q = quoteByKey(st.pair);
    const thr = q ? toUnits($("#c-thr").value, decOf(q)) : null;
    if (!name) { say("give it a name", true); return; }
    if (!ticker) { say("ticker: 1-10 of A-Z, 0-9", true); return; }
    if (!q || thr == null || thr === 0n) { say("pick a target to raise", true); return; }
    if (st.min[st.pair] != null && thr < st.min[st.pair]) { say(`at least ${fmtUnits(st.min[st.pair], decOf(q))} ${q.sym} for this pair`, true); return; }
    const data = encLaunch(name, ticker, q.address, thr, st.bps);
    const btn = $("#c-launch");
    btn.disabled = true;
    try {
      const [account] = await provider.request({ method: "eth_requestAccounts" });
      await ensureChain(provider);
      say("checking the launch…");
      await rpc("eth_call", [{ from: account, to: CV().address, data }, "latest"]);
      const { hash, receipt } = await sendTx(provider, { from: account, to: CV().address, data }, "launch", say);
      const log = (receipt.logs || []).find((l) => l.topics && l.topics[0] === TOPIC_LAUNCHED);
      const token = log ? addrAt(log.topics[1], 0) : null;
      btn.textContent = "LAUNCHED ✓"; btn.style.background = "var(--mint-deep)";
      say(`${name} (${ticker}) is on the curve. See it: ${CFG().explorer}/tx/${hash}`);
      await loadGallery();
      if (token) openTrade(token);
    } catch (e) {
      say(short(e), true);
      btn.disabled = false;
    }
  }

  // ---- la galleria ------------------------------------------------------------------
  const launches = new Map();   // token -> {token, quote, creator, bps, startBlock, graduated, threshold, virtualQuote, raised, sold, lpId, pool, name, symbol}

  function decodeLaunch(hex, token) {
    return { token, quote: addrAt(hex, 1), creator: addrAt(hex, 2), bps: Number(wordAt(hex, 3)), startBlock: Number(wordAt(hex, 4)),
      graduated: wordAt(hex, 5) === 1n, threshold: wordAt(hex, 6), virtualQuote: wordAt(hex, 7), raised: wordAt(hex, 8),
      sold: wordAt(hex, 9), lpId: wordAt(hex, 10), pool: addrAt(hex, 11) };
  }
  const decStr = (hex) => { try { const len = Number(wordAt(hex, 1)); const b = hex.slice(2 + 128, 2 + 128 + len * 2);
    return new TextDecoder().decode(new Uint8Array(b.match(/../g).map((x) => parseInt(x, 16)))).replace(/[ -]/g, " "); } catch (_) { return "?"; } };

  async function loadGallery() {
    const gal = $("#gal"), cnt = $("#gal-count");
    if (!READABLE) { cnt.textContent = "NOTHING DEPLOYED"; gal.innerHTML = ""; return; }
    try {
      const n = Number(wordAt(await curveCall(S.count), 0));
      cnt.textContent = `${n} LAUNCH${n === 1 ? "" : "ES"}`;
      if (!n) { gal.innerHTML = `<p class="gal-note">nothing on the curve yet — yours would be the first.</p>`; return; }
      const idx = Array.from({ length: n }, (_, i) => n - 1 - i);          // i piu' nuovi prima
      const toks = (await rpcBatch(idx.map((i) => ecall(CV().address, S.tokens + word(i))))).map((h) => addrAt(h, 0));
      const res = await rpcBatch(toks.flatMap((t) => [ecall(CV().address, S.launches + addrWord(t)), ecall(t, S.name), ecall(t, S.symbol)]));
      toks.forEach((t, i) => {
        const prev = launches.get(t) || {};
        launches.set(t, { ...prev, ...decodeLaunch(res[i * 3], t), name: decStr(res[i * 3 + 1]), symbol: decStr(res[i * 3 + 2]) });
      });
      gal.innerHTML = toks.map((t) => card(launches.get(t))).join("");
    } catch (e) {
      cnt.textContent = "RPC BUSY"; if (!gal.children.length) gal.innerHTML = `<p class="gal-note">${esc(short(e))}</p>`;
    }
  }

  function card(l) {
    const q = quoteByAddr(l.quote), dec = decOf(q);
    const pct = l.graduated ? 100 : Number(l.sold * 10000n / CURVE_SUPPLY) / 100;
    return `<button class="cchip" data-token="${l.token}" type="button">` +
      `<div class="row1"><span class="tick">${esc(l.symbol)}</span>` +
      `<span class="badge ${l.graduated ? "grad" : "live"}">${l.graduated ? "IN THE MARKET" : "ON THE CURVE"}</span></div>` +
      `<div class="name">${esc(l.name)} · ${esc(q.sym)}${l.bps ? "" : " · 100% buyback"}</div>` +
      `<div class="bar"><i style="width:${pct}%"></i></div>` +
      `<div class="grow"><span>${l.graduated ? "GRADUATED" : "RAISED"} <b>${fmtUnits(l.raised, dec)} ${esc(q.sym)}</b></span>` +
      `<span>${l.graduated ? "LP SEALED" : `TARGET <b>${fmtUnits(l.threshold, dec)}</b> · <b>${pct.toFixed(1)}%</b>`}</span></div></button>`;
  }
  $("#gal").addEventListener("click", (e) => { const b = e.target.closest("[data-token]"); if (b) openTrade(b.dataset.token); });

  // ---- la scheda del trade -------------------------------------------------------------
  let modal = null, tradeToken = null, tradeSide = "buy", previewSeq = 0;

  async function openTrade(token) {
    tradeToken = token; tradeSide = "buy";
    document.querySelectorAll(".lp-modal").forEach((m) => m.remove());
    modal = document.createElement("div");
    modal.className = "lp-modal";
    modal.innerHTML = `<div class="box" role="dialog"><button class="x" type="button" aria-label="close">✕</button><div id="tr-body">reading the curve…</div></div>`;
    document.body.appendChild(modal);
    modal.querySelector(".x").addEventListener("click", closeTrade);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeTrade(); });
    await drawTrade(true);
  }
  function closeTrade() { if (modal) modal.remove(); modal = null; tradeToken = null; }

  async function refreshLaunch(token) {
    const res = await rpcBatch([ecall(CV().address, S.launches + addrWord(token)), ecall(token, S.name), ecall(token, S.symbol), ecall(CV().address, S.price + addrWord(token)), { method: "eth_blockNumber", params: [] }]);
    const l = { ...(launches.get(token) || {}), ...decodeLaunch(res[0], token), name: decStr(res[1]), symbol: decStr(res[2]), price: wordAt(res[3], 0), block: Number(BigInt(res[4])) };
    launches.set(token, l);
    return l;
  }

  /** rebuild=true ridisegna anche il form (apertura, cambio lato, dopo un trade);
   *  il refresh periodico aggiorna solo la testa, cosi' non cancella quello che stai scrivendo. */
  async function drawTrade(rebuild) {
    if (!modal || !tradeToken) return;
    const body = modal.querySelector("#tr-body");
    let l;
    try { l = await refreshLaunch(tradeToken); } catch (e) { body.innerHTML = `<p class="status is-bad">${esc(short(e))}</p>`; return; }
    const q = quoteByAddr(l.quote), dec = decOf(q);
    const pct = l.graduated ? 100 : Number(l.sold * 10000n / CURVE_SUPPLY) / 100;
    const ex = CFG().explorer;
    const acct = window.RH4_WALLET && window.RH4_WALLET.address;
    let bal = 0n, qbal = 0n;
    if (acct) { try {
      const r = await rpcBatch([ecall(l.token, S.balanceOf + addrWord(acct)),
        q.address.toLowerCase() === WETH.toLowerCase() ? { method: "eth_getBalance", params: [acct, "latest"] } : ecall(q.address, S.balanceOf + addrWord(acct))]);
      bal = wordAt(r[0], 0); qbal = BigInt(r[1]);
    } catch (_) {} }
    const fdv = l.price * SUPPLY / 10n ** 18n;   // in unita' grezze della quota
    const head =
      `<p class="pill"><span class="pill-n">${l.graduated ? "MARKET" : "CURVE"}</span>${esc(q.sym)} PAIR</p>` +
      `<h2>${esc(l.symbol)}</h2>` +
      `<div class="sub">${esc(l.name)} · <a href="${ex}/token/${l.token}" target="_blank" rel="noopener">token ↗</a>` +
      (l.graduated ? ` · <a href="${ex}/address/${l.pool}" target="_blank" rel="noopener">pool ↗</a>` : "") +
      ` · creator ${l.creator.slice(0, 6)}…${l.creator.slice(-4)}</div>` +
      `<div class="kv"><span>PRICE</span><b>${fmtUnits(l.price, dec, 8)} ${esc(q.sym)}</b>` +
      `<span>FDV</span><b>${fmtUnits(fdv, dec)} ${esc(q.sym)}</b>` +
      `<span>${l.graduated ? "RAISED" : "PROGRESS"}</span><b>${l.graduated ? fmtUnits(l.raised, dec) + " " + esc(q.sym) : pct.toFixed(1) + "% · " + fmtUnits(l.raised, dec) + " / " + fmtUnits(l.threshold, dec) + " " + esc(q.sym)}</b>` +
      `<span>FEES</span><b>${l.bps ? "50% creator · 50% buyback" : "100% buyback"}</b>` +
      (acct ? `<span>YOU HOLD</span><b>${fmtUnits(bal, 18)} ${esc(l.symbol)}</b>` : "") + `</div>`;
    const headEl = body.querySelector("#tr-head");
    if (headEl && !rebuild && body.querySelector("#tr-amt") && !l.graduated) { headEl.innerHTML = head; return; }
    if (l.graduated) {
      body.innerHTML = `<div id="tr-head">${head}</div>` +
        `<div class="simple-note">The curve is full. <b>200M</b> ${esc(l.symbol)} and <b>${fmtUnits(l.raised, dec)} ${esc(q.sym)}</b> seed a Uniswap v3 market whose LP position is sealed forever. Trade it from any Uniswap v3 interface or bot on Robinhood Chain (fee tier 1%).</div>` +
        `<div class="acts" style="margin-top:14px"><a class="btn btn-dark btn-block" href="${ex}/address/${l.pool}" target="_blank" rel="noopener">SEE THE POOL ↗</a></div>`;
      return;
    }
    body.innerHTML = `<div id="tr-head">${head}</div>` +
      `<div class="chips" id="tr-side"><button class="chip${tradeSide === "buy" ? " is-on" : ""}" data-side="buy">BUY</button><button class="chip${tradeSide === "sell" ? " is-on" : ""}" data-side="sell">SELL</button></div>` +
      `<label class="field" style="margin-top:12px"><span class="field-k" style="display:flex;justify-content:space-between">` +
      `<span>${tradeSide === "buy" ? "PAY " + esc(q.sym) : "SELL " + esc(l.symbol)}</span>` +
      (acct ? `<button class="max" type="button" id="tr-max">MAX ${tradeSide === "buy" ? fmtUnits(qbal, dec) : fmtUnits(bal, 18)}</button>` : "") + `</span>` +
      `<input id="tr-amt" type="text" inputmode="decimal" placeholder="0" autocomplete="off"></label>` +
      `<div class="preview" id="tr-prev"></div>` +
      `<div class="acts"><button class="btn btn-dark btn-block" id="tr-go" ${LIVE ? "" : "disabled"}>${LIVE ? (tradeSide === "buy" ? "BUY" : "SELL") : "PREVIEW — TRADES OFF"}</button></div>` +
      `<p class="status" id="tr-status"></p>` +
      `<p class="field-note" style="margin-top:10px">1% fee, 1% slippage floor. ${tradeSide === "buy" ? "Until the curve fills, tokens can be sold back here any time." : "Selling walks the price back down the same curve."}</p>`;
    body.querySelector("#tr-side").addEventListener("click", (e) => { const b = e.target.closest("[data-side]"); if (b && b.dataset.side !== tradeSide) { tradeSide = b.dataset.side; drawTrade(true); } });
    const amt = body.querySelector("#tr-amt");
    amt.addEventListener("input", () => preview(l, q));
    const mx = body.querySelector("#tr-max");
    if (mx) mx.addEventListener("click", () => {
      // in ETH si lascia un po' per il gas
      const v = tradeSide === "buy" ? (q.address.toLowerCase() === WETH.toLowerCase() ? (qbal > 10n ** 15n ? qbal - 10n ** 15n : 0n) : qbal) : bal;
      amt.value = (Number(v) / 10 ** (tradeSide === "buy" ? dec : 18)).toString(); preview(l, q);
    });
    body.querySelector("#tr-go").addEventListener("click", () => trade(l, q));
    amt.focus();
  }

  async function preview(l, q) {
    const seq = ++previewSeq;
    const el = modal && modal.querySelector("#tr-prev"); if (!el) return;
    const dec = decOf(q);
    const v = toUnits(modal.querySelector("#tr-amt").value, tradeSide === "buy" ? dec : 18);
    if (v == null || v === 0n) { el.textContent = ""; return; }
    try {
      if (tradeSide === "buy") {
        const r = await curveCall(S.quoteBuy + addrWord(l.token) + word(v));
        if (seq !== previewSeq) return;
        const out = wordAt(r, 0), fee = wordAt(r, 1);
        const fills = out >= CURVE_SUPPLY - l.sold;
        const early = out > MAX_EARLY_BUY && l.block < l.startBlock + 100;   // l'anti-snipe vale anche per la compra che riempie
        el.innerHTML = `≈ <b>${fmtUnits(out, 18)} ${esc(l.symbol)}</b> · fee ${fmtUnits(fee, dec)} ${esc(q.sym)}` +
          (fills ? ` · <b>fills the curve</b>: the excess comes back, the market opens in the same transaction` : "") +
          (early ? ` · above the 2% early cap: only allowed after block ${l.startBlock + 100}` : "");
        el.dataset.out = out.toString();
      } else {
        const r = await curveCall(S.quoteSell + addrWord(l.token) + word(v));
        if (seq !== previewSeq) return;
        const out = wordAt(r, 0), fee = wordAt(r, 1);
        el.innerHTML = `≈ <b>${fmtUnits(out, dec)} ${esc(q.sym)}</b> · fee ${fmtUnits(fee, dec)} ${esc(q.sym)}`;
        el.dataset.out = out.toString();
      }
    } catch (e) { if (seq === previewSeq) el.textContent = short(e); }
  }

  async function trade(l, q) {
    const provider = window.ethereum;
    const status = (m, bad) => { const s = modal && modal.querySelector("#tr-status"); if (s) { s.textContent = m || ""; s.classList.toggle("is-bad", Boolean(bad)); } };
    if (!provider) { status("no wallet found in this browser", true); return; }
    const dec = decOf(q);
    const v = toUnits(modal.querySelector("#tr-amt").value, tradeSide === "buy" ? dec : 18);
    if (v == null || v === 0n) { status("type an amount", true); return; }
    const go = modal.querySelector("#tr-go"); go.disabled = true;
    try {
      const [account] = await provider.request({ method: "eth_requestAccounts" });
      await ensureChain(provider);
      const isEth = q.address.toLowerCase() === WETH.toLowerCase();
      if (tradeSide === "buy") {
        const out = wordAt(await curveCall(S.quoteBuy + addrWord(l.token) + word(v)), 0);
        const minOut = out * 99n / 100n;
        if (!isEth) await approveIf(provider, account, q.address, CV().address, v, status);
        const data = S.buy + addrWord(l.token) + word(isEth ? 0n : v) + word(minOut);
        const tx = { from: account, to: CV().address, data, ...(isEth && { value: "0x" + v.toString(16) }) };
        await rpc("eth_call", [tx, "latest"]);
        await sendTx(provider, tx, isEth ? "buy" : "2/2 buy", status);
        status(`bought — ${fmtUnits(out, 18)} ${l.symbol} are yours`);
      } else {
        const out = wordAt(await curveCall(S.quoteSell + addrWord(l.token) + word(v)), 0);
        const minOut = out * 99n / 100n;
        await approveIf(provider, account, l.token, CV().address, v, status);
        const data = S.sell + addrWord(l.token) + word(v) + word(minOut);
        const tx = { from: account, to: CV().address, data };
        await rpc("eth_call", [tx, "latest"]);
        await sendTx(provider, tx, "2/2 sell", status);
        status(`sold — ${fmtUnits(out, dec)} ${q.sym} back in your wallet`);
      }
      loadGallery();
      await drawTrade(true);
    } catch (e) {
      status(short(e), true);
      if (go.isConnected) go.disabled = false;
    }
  }

  // ---- via --------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    if (!gate()) return;
    buildPairs(); drawPresets(); drawNote();
    const btn = $("#c-launch");
    if (LIVE) { btn.disabled = false; btn.addEventListener("click", launch); }
    else btn.textContent = READABLE ? "PREVIEW — LAUNCHES OFF" : "NOT DEPLOYED";
    if (window.RH4_WALLET) window.RH4_WALLET.onChange(() => { if (modal) drawTrade(); });
    await loadMins();
    await loadGallery();
    setInterval(() => { if (document.visibilityState === "visible") { loadGallery(); if (modal) drawTrade(); } }, 20000);
  });
})();
