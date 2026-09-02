/**
 * chip.js — la pagina di un singolo chip: stato vivo, mercato, trades.
 *
 * Tutto senza backend: lo stato dal contratto, il grafico e i trades dagli
 * eventi Swap del pool, letti via eth_getLogs. Ogni Swap porta con se' il
 * prezzo (sqrtPriceX96), quindi la serie nasce direttamente dagli eventi.
 */
(function () {
  "use strict";

  const CFG = () => window.RH4_CONFIG || {};
  const $ = (s) => document.querySelector(s);

  const S_CHIP = "0x8c6aefcf", S_INSPECT = "0xb3e98ae8", S_LOGO = "0xa29ba8a7",
        S_EMISSION = "0x58292a3d", S_TICK = "0xe5bbf637",
        S_GETPOOL = "0x1698ee82", S_SLOT0 = "0x3850c7bd", S_BAL = "0x70a08231";
  const TOPIC_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

  const UNI = {
    V3F: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    DEAD: "0x000000000000000000000000000000000000dEaD",
    FEE: 10000,
  };

  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const addrWord = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  const short = (e) => String((e && (e.message || e)) || "error").slice(0, 90);
  const ZERO = "0x" + "0".repeat(40);

  function b32ToString(hex) {
    let out = "";
    for (let i = 0; i < 64; i += 2) {
      const c = parseInt(hex.slice(i, i + 2), 16);
      if (c === 0) break;
      out += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : " ";
    }
    return out;
  }
  /** int256 dal log: complemento a due. */
  function i256(hex) {
    let v = BigInt("0x" + hex);
    if (v >= 1n << 255n) v -= 1n << 256n;
    return v;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function rpc(method, params, tries = 4) {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(CFG().rpc, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || "rpc error");
        return data.result;
      } catch (e) {
        if (i >= tries - 1) throw e;
        await sleep(600 * (i + 1)); // l'RPC pubblico sbuffa: gli si da' respiro
      }
    }
  }
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

  const id = Math.max(1, Number(new URLSearchParams(location.search).get("id") || 1));
  const state = { token: ZERO, reward: 0, pool: null, quote: null, quoteSym: "WETH" };

  // ------------------------------------------------------------ lo stato vivo

  async function loadChip() {
    const w = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
    const F = CFG().factory;
    const [chipHex, insHex, logoHex, emiHex, nowHex] = await Promise.all([
      call(F, S_CHIP + word(id)), call(F, S_INSPECT + word(id)),
      call(F, S_LOGO + word(id)), call(F, S_EMISSION + word(id)),
      rpc("eth_blockNumber", []),
    ]);

    const ticker = b32ToString(w(chipHex, 2));
    const label = b32ToString(w(chipHex, 1));
    state.token = "0x" + w(chipHex, 6).slice(24);
    state.bornBlock = Number(BigInt("0x" + w(chipHex, 4)));

    document.title = `${ticker} — chip #${id} — RH-4`;
    $("#cp-ticker").textContent = ticker || `CHIP #${id}`;
    $("#cp-sub").textContent = `#${id} · ${label} · 2368 NAND / 171 FF / 256 B RAM`;
    $("#cp-nft-link").href = `${CFG().explorer}/token/${F}/instance/${id}`;
    if (state.token !== ZERO) {
      $("#cp-token-link").href = `${CFG().explorer}/token/${state.token}`;
      $("#cp-token-link").hidden = false;
    }

    // logo
    try {
      const len = Number(BigInt("0x" + w(logoHex, 1)));
      if (len > 0) {
        const raw = logoHex.slice(2 + 128, 2 + 128 + len * 2);
        const uri = decodeURIComponent(raw.replace(/(..)/g, "%$1"));
        $("#cp-logo").src = uri.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/");
      }
    } catch (_) {}

    // stato macchina
    const pc = Number(BigInt("0x" + w(insHex, 0)));
    const out = Number(BigInt("0x" + w(insHex, 1)));
    const halted = BigInt("0x" + w(insHex, 2)) === 1n;
    const cycles = Number(BigInt("0x" + w(insHex, 3)));
    const behind = Number(BigInt(nowHex) - BigInt("0x" + w(insHex, 4)));
    const badge = halted ? ["HALTED", "halt"] : behind > 600 ? ["IDLE", "stall"] : ["RUNNING", "run"];
    const el = $("#cp-badge");
    el.textContent = badge[0];
    el.className = "cp-badge " + badge[1];
    $("#cp-live").textContent = badge[0] === "RUNNING" ? "● LIVE" : badge[0];
    $("#cp-cycles").textContent = cycles.toLocaleString("en-US");
    $("#cp-pc").textContent = "0x" + pc.toString(16).padStart(3, "0");
    $("#cp-out").textContent = out;
    document.querySelectorAll("#cp-leds .cpled").forEach((led, i) =>
      led.classList.toggle("on", (out >> (7 - i)) & 1));

    // emissione
    const reserve = BigInt("0x" + w(emiHex, 1));
    const reward = BigInt("0x" + w(emiHex, 2));
    const left = BigInt("0x" + w(emiHex, 3));
    state.reward = Number(reward) / 1e18;
    $("#cp-reward").textContent = state.reward ? state.reward.toFixed(2) : "0";
    $("#cp-emis").innerHTML =
      `<div class="row"><span>RESERVE</span><b>${(Number(reserve) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })}</b></div>` +
      `<div class="row"><span>PER CYCLE</span><b>${state.reward.toFixed(3)}</b></div>` +
      `<div class="row"><span>CYCLES LEFT</span><b>${Number(left).toLocaleString("en-US")}</b></div>`;
  }

  // ------------------------------------------------------------- il mercato

  async function findPool() {
    if (state.token === ZERO) return null;
    for (const [quote, sym] of [[UNI.WETH, "WETH"], [UNI.NVDA, "NVDA"]]) {
      const [t0, t1] = state.token.toLowerCase() < quote.toLowerCase()
        ? [state.token, quote] : [quote, state.token];
      const pool = "0x" + (await call(UNI.V3F,
        S_GETPOOL + addrWord(t0) + addrWord(t1) + word(UNI.FEE))).slice(26);
      if (pool !== ZERO) return { pool, quote, sym, ourIsToken0: t0.toLowerCase() === state.token.toLowerCase() };
    }
    return null;
  }

  /** prezzo (quote per token) da sqrtPriceX96, orientato al nostro token. */
  function priceFrom(sqrtX96, ourIsToken0) {
    const p = Number(sqrtX96) ** 2 / 2 ** 192; // token1 per token0
    return ourIsToken0 ? p : 1 / p;
  }
  const fmtP = (p) => p >= 1 ? p.toFixed(4) : p.toPrecision(4);

  async function loadMarket() {
    const found = await findPool();
    if (!found) {
      $("#chart").hidden = true;
      const nm = $("#cp-nomarket");
      nm.hidden = false;
      nm.innerHTML = id === 1
        ? `the mother trades on <a href="https://www.ponsfamily.com/launchpad/${state.token}">pons</a> — chart and trades live there`
        : `no market yet — the minter has not opened it.<br>when it opens, the LP position is born at the burn address.`;
      $("#cp-price").textContent = "—";
      return;
    }
    Object.assign(state, found);

    // LP bruciata? la posizione appartiene all'inceneritore se il flusso e' il nostro
    // (indicatore semplice: il pool esiste -> mostriamo il fee tier; il burn si
    //  dichiara nei trades del minter, verificabile dall'explorer)
    $("#cp-lp").textContent = "1% FEE";

    // prezzo corrente
    const slot0 = await call(state.pool, S_SLOT0);
    const sqrtX96 = BigInt("0x" + slot0.slice(2, 66));
    const price = priceFrom(sqrtX96, state.ourIsToken0);
    $("#cp-price").textContent = `${fmtP(price)} ${state.sym}`;
    $("#cp-fdv").textContent = `${(price * 1e9).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${state.sym}`;

    // eventi Swap, a fette dal blocco di nascita del chip: il mercato non
    // puo' esistere prima del chip, e le fette tengono buono l'RPC pubblico
    const now = Number(BigInt(await rpc("eth_blockNumber", [])));
    const CHUNK = 500000;
    let logs = [];
    let gaps = 0;
    for (let from = state.bornBlock || 1; from <= now; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, now);
      try {
        const part = await rpc("eth_getLogs", [{
          address: state.pool, topics: [TOPIC_SWAP],
          fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
        }], 6);
        logs = logs.concat(part);
      } catch (_) {
        gaps++; // l'RPC pubblico a volte tossisce: meglio un buco che il buio
      }
      await sleep(200);
    }
    if (gaps) $("#cp-ntrades").title = `${gaps} block ranges unavailable — refresh to fill`;
    $("#cp-ntrades").textContent = logs.length;

    // tempi: interpolazione lineare fra primo e ultimo blocco (blocchi ~costanti)
    let t0 = Date.now() / 1000, perBlock = 0.25, b0 = 0;
    if (logs.length) {
      b0 = Number(BigInt(logs[0].blockNumber));
      const bN = Number(BigInt(logs[logs.length - 1].blockNumber));
      const [h0, hN] = await Promise.all([
        rpc("eth_getBlockByNumber", [logs[0].blockNumber, false]),
        rpc("eth_getBlockByNumber", [logs[logs.length - 1].blockNumber, false]),
      ]);
      t0 = Number(BigInt(h0.timestamp));
      const tN = Number(BigInt(hN.timestamp));
      perBlock = bN > b0 ? (tN - t0) / (bN - b0) : 0.25;
    }
    const timeOf = (bn) => Math.round(t0 + (Number(BigInt(bn)) - b0) * perBlock);

    // serie prezzo + lista trades
    const series = [];
    const rows = [];
    let lastT = 0;
    for (const log of logs) {
      const d = log.data.slice(2);
      const a0 = i256(d.slice(0, 64));
      const a1 = i256(d.slice(64, 128));
      const sqrt = BigInt("0x" + d.slice(128, 192));
      const p = priceFrom(sqrt, state.ourIsToken0);
      let time = timeOf(log.blockNumber);
      if (time <= lastT) time = lastT + 1; // il grafico vuole tempi crescenti
      lastT = time;
      series.push({ time, value: p });

      const ourAmt = state.ourIsToken0 ? a0 : a1;
      const quoteAmt = state.ourIsToken0 ? a1 : a0;
      const buy = ourAmt < 0n; // il pool cede token: qualcuno compra
      rows.push({
        buy, p, time,
        tokens: Number(ourAmt < 0n ? -ourAmt : ourAmt) / 1e18,
        quote: Number(quoteAmt < 0n ? -quoteAmt : quoteAmt) / 1e18,
        tx: log.transactionHash,
      });
    }

    // grafico: area sui toni del progetto, fluido
    if (series.length && window.LightweightCharts) {
      const chart = LightweightCharts.createChart($("#chart"), {
        layout: { background: { color: "#0c0d0b" }, textColor: "#6f7669",
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
        grid: { vertLines: { color: "#171a16" }, horzLines: { color: "#171a16" } },
        rightPriceScale: { borderColor: "#272a25" },
        timeScale: { borderColor: "#272a25", timeVisible: true, secondsVisible: true },
        crosshair: { vertLine: { color: "#8fe8b0", width: 1, style: 2 },
                     horzLine: { color: "#8fe8b0", width: 1, style: 2 } },
        handleScroll: true, handleScale: true,
      });
      const area = chart.addAreaSeries({
        lineColor: "#8fe8b0", topColor: "rgba(143,232,176,0.25)",
        bottomColor: "rgba(143,232,176,0.02)", lineWidth: 2,
        priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
      });
      area.setData(series);
      chart.timeScale().fitContent();
      new ResizeObserver(() => chart.applyOptions({ width: $("#chart").clientWidth }))
        .observe($("#chart"));
    } else if (!series.length) {
      $("#chart").style.height = "80px";
      $("#chart").innerHTML = "<div class='cp-nomarket'>market is open — waiting for the first trade</div>";
    }

    // trades, dal piu' recente
    const host = $("#trades");
    for (const r of rows.reverse().slice(0, 200)) {
      const el = document.createElement("div");
      el.className = "trow";
      el.innerHTML =
        `<span class="side ${r.buy ? "buy" : "sell"}">${r.buy ? "BUY" : "SELL"}</span>` +
        `<span class="num">${r.tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>` +
        `<span class="num">${r.quote.toFixed(5)} ${state.sym}</span>` +
        `<span class="num">${fmtP(r.p)}</span>` +
        `<a href="${CFG().explorer}/tx/${r.tx}" target="_blank">${r.tx.slice(0, 8)}…</a>`;
      host.appendChild(el);
    }
  }

  // ------------------------------------------------------- POWER per questo chip

  function buildPower() {
    const btn = $("#cp-tick");
    btn.addEventListener("click", async () => {
      const provider = window.ethereum;
      if (!provider) { $("#cp-power-note").innerHTML = "no wallet found in this browser"; return; }
      btn.disabled = true;
      try {
        const [account] = await provider.request({ method: "eth_requestAccounts" });
        try {
          await provider.request({ method: "wallet_switchEthereumChain",
            params: [{ chainId: CFG().chainIdHex }] });
        } catch (e) {
          if (e && e.code === 4902) {
            await provider.request({ method: "wallet_addEthereumChain", params: [{
              chainId: CFG().chainIdHex, chainName: CFG().chainName,
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [CFG().rpc], blockExplorerUrls: [CFG().explorer] }] });
          } else throw e;
        }
        const byte = Math.max(0, Math.min(255, Number($("#cp-byte").value) || 0));
        const hash = await provider.request({ method: "eth_sendTransaction", params: [{
          from: account, to: CFG().factory,
          data: S_TICK + word(id) + word(byte),
        }] });
        $("#cp-power-note").innerHTML = `cycle sent — <b>${hash.slice(0, 10)}…</b> waiting`;
        let r = null;
        for (let i = 0; i < 40 && !r; i++) { await new Promise((x) => setTimeout(x, 2500)); r = await rpc("eth_getTransactionReceipt", [hash]); }
        $("#cp-power-note").innerHTML = r && r.status === "0x1"
          ? `cycle is yours — you are in the Cycle event for it, and <b>${state.reward.toFixed(2)}</b> arrived`
          : "did not land — someone may have taken this block's cycle";
        loadChip();
      } catch (e) {
        $("#cp-power-note").textContent = short(e);
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function init() {
    // override di collaudo: permette di puntare una factory diversa dal
    // proprio browser, senza toccare il sito. Solo lettura, nessun rischio.
    try {
      const o = localStorage.getItem("rh4_factory");
      if (o) window.RH4_CONFIG.factory = o;
    } catch (_) {}
    try {
      await loadChip();
      buildPower();
      await loadMarket();
      setInterval(loadChip, 15000);
    } catch (e) {
      $("#cp-sub").textContent = short(e);
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
