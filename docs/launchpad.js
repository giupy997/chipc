/**
 * launchpad.js — la pagina dedicata del launchpad.
 *
 * Due meta': la galleria dei chip vivi (letta via eth_call, nessun backend:
 * la fabbrica E' il database) e il form di conio, lo stesso flusso collaudato
 * della home ma senza il simulatore attorno.
 */
(function () {
  "use strict";

  const CFG = () => window.RH4_CONFIG || {};
  const $ = (s) => document.querySelector(s);

  const SELECTOR_MINT = "0x481aebcf";     // mint(uint256[128],bytes32,bytes32,string,uint16,uint64)
  const SELECTOR_BYTICKER = "0x4da5bb73"; // chipByTicker(bytes32)
  const SELECTOR_TOTAL = "0x73514205";    // totalChips()
  const SELECTOR_CHIP = "0x8c6aefcf";     // chip(uint256)
  const SELECTOR_INSPECT = "0xb3e98ae8";  // inspect(uint256)
  const SELECTOR_LOGO = "0xa29ba8a7";     // logo(uint256)
  const TOPIC_MINTED = "0xe16ebcd5826e8fad06bc57cf29dbfb38c93766eb6df5320acceb51366f717d37";

  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const short = (e) => String((e && (e.message || e)) || "error").slice(0, 90);

  function safeTicker(raw) {
    return String(raw).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 8);
  }

  function b32(s) {
    const bytes = new TextEncoder().encode(s);
    if (bytes.length === 0 || bytes.length > 32) return null;
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex.padEnd(64, "0");
  }

  function b32ToString(hex) {
    let out = "";
    for (let i = 0; i < 64; i += 2) {
      const c = parseInt(hex.slice(i, i + 2), 16);
      if (c === 0) break;
      out += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : " ";
    }
    return out;
  }

  async function rpc(method, params) {
    const res = await fetch(CFG().rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "rpc error");
    return data.result;
  }
  const call = (data) => rpc("eth_call", [{ to: CFG().factory, data }, "latest"]);

  // ------------------------------------------------------------ la galleria

  function chipCard(id, c, s, logoURI) {
    const running = !s.halted;
    const stalled = running && s.behindBlocks > 600; // ~1 minuto senza tick
    const badge = s.halted ? ["HALTED", "halt"] : stalled ? ["IDLE", "stall"] : ["RUNNING", "run"];
    const leds = Array.from({ length: 8 }, (_, i) =>
      `<div class="gled${(s.out >> (7 - i)) & 1 ? " on" : ""}"></div>`).join("");
    const logo = logoURI
      ? `<img class="glogo" src="${logoURI.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")}" alt="" loading="lazy">`
      : "";
    const href = c.token && c.token !== "0x" + "0".repeat(40)
      ? `${CFG().explorer}/token/${c.token}`
      : `${CFG().explorer}/address/${CFG().factory}`;

    const el = document.createElement("a");
    el.className = "gchip";
    el.href = href;
    el.innerHTML =
      `<div class="row1"><span class="tick">${c.ticker || "?"}</span>${logo}` +
      `<span class="badge ${badge[1]}">${badge[0]}</span></div>` +
      `<div class="name">#${id} · ${c.label || "unnamed"}</div>` +
      `<div class="gleds">${leds}</div>` +
      `<div class="grow"><span>CYCLES <b>${s.cycles.toLocaleString("en-US")}</b></span>` +
      `<span>OUT <b>${s.out}</b></span><span>PC <b>0x${s.pc.toString(16).padStart(3, "0")}</b></span></div>`;
    return el;
  }

  async function loadGallery() {
    const host = $("#gal");
    const count = $("#gal-count");
    if (!host) return;
    try {
      const total = Number(BigInt(await call(SELECTOR_TOTAL)));
      count.textContent = `${total} CHIP${total === 1 ? "" : "S"} MINTED`;
      const nowBlock = BigInt(await rpc("eth_blockNumber", []));

      host.innerHTML = "";
      // dal piu' recente al piu' vecchio, come ogni launchpad che si rispetti
      for (let id = total; id >= 1; id--) {
        const [chipHex, insHex, logoHex] = await Promise.all([
          call(SELECTOR_CHIP + word(id)),
          call(SELECTOR_INSPECT + word(id)),
          call(SELECTOR_LOGO + word(id)),
        ]);
        const w = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
        const c = {
          label: b32ToString(w(chipHex, 1)),
          ticker: b32ToString(w(chipHex, 2)),
          token: "0x" + w(chipHex, 6).slice(24),
        };
        const lastBlock = BigInt("0x" + w(insHex, 4));
        const s = {
          pc: Number(BigInt("0x" + w(insHex, 0))),
          out: Number(BigInt("0x" + w(insHex, 1))),
          halted: BigInt("0x" + w(insHex, 2)) === 1n,
          cycles: Number(BigInt("0x" + w(insHex, 3))),
          behindBlocks: Number(nowBlock - lastBlock),
        };
        // il logo e' una string dinamica: offset, lunghezza, byte
        let logoURI = "";
        try {
          const len = Number(BigInt("0x" + w(logoHex, 1)));
          if (len > 0) {
            const raw = logoHex.slice(2 + 128, 2 + 128 + len * 2);
            logoURI = decodeURIComponent(raw.replace(/(..)/g, "%$1"));
          }
        } catch (_) {}
        host.appendChild(chipCard(id, c, s, logoURI));
      }
    } catch (e) {
      count.textContent = "the factory did not answer — refresh";
    }
  }

  // ------------------------------------------------------------- il calcolo

  let liqBps = 2000;
  let spanSeconds = 7776000;
  let mintProg = "echo";
  let pair = "weth";
  let logoURI = "";

  function drawEmission() {
    const host = $("#f-emission");
    if (!host) return;
    const SUPPLY = 1e9;
    const cycles = spanSeconds * 10;
    const reserve = SUPPLY * (1 - liqBps / 10000);
    const perCycle = reserve / cycles;
    const fmt = (n) => Math.round(n).toLocaleString("en-US");
    host.innerHTML =
      `<div class="em-row"><span>TO LIQUIDITY</span><b>${fmt(SUPPLY - reserve)} YOURS</b></div>` +
      `<div class="em-row"><span>EARNED BY CYCLES</span><b>${fmt(reserve)}</b></div>` +
      `<div class="em-row"><span>PER CLOCK CYCLE</span><b>${perCycle.toFixed(2)}</b></div>` +
      `<div class="em-row"><span>TRADES AGAINST</span><b>${pair.toUpperCase()}</b></div>`;
  }

  function wireChips(sel, apply) {
    document.querySelectorAll(sel).forEach((b) => {
      b.addEventListener("click", (e) => {
        e.preventDefault();
        document.querySelectorAll(sel).forEach((x) => x.classList.toggle("is-on", x === b));
        apply(b);
        drawEmission();
      });
    });
  }

  // --------------------------------------------------------------- il conio

  function encodeMint(slots, labelHex, tickerHex, logo, liq, targetCycles) {
    let head = "";
    for (const s of slots) head += word(s);
    head += labelHex + tickerHex + word(133 * 32) + word(liq) + word(targetCycles);
    const logoBytes = new TextEncoder().encode(logo);
    let tail = word(logoBytes.length);
    let hex = "";
    for (const b of logoBytes) hex += b.toString(16).padStart(2, "0");
    tail += hex.padEnd(Math.ceil(hex.length / 64) * 64 || 0, "0");
    return SELECTOR_MINT + head + tail;
  }

  function say(msg, bad) {
    const el = $("#f-mint-note");
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || "";
    el.classList.toggle("is-bad", Boolean(bad));
  }

  async function walletMint(btn) {
    const provider = window.ethereum;
    if (!provider) { say("no wallet found in this browser", true); return; }

    const name = $("#f-name").value.trim();
    const ticker = safeTicker($("#f-ticker").value);
    const labelHex = b32(name);
    const tickerHex = b32(ticker);
    if (!labelHex) { say("the name must be 1–32 bytes", true); return; }
    if (!tickerHex || !ticker) { say("a chip needs a ticker", true); return; }
    if (logoURI && !/^(https:\/\/|ipfs:\/\/)[\x20-\x21\x23-\x5b\x5d-\x7e]{1,190}$/.test(logoURI)) {
      say("logo URI must be https:// or ipfs://", true); return;
    }

    const prog = (window.RH4_PROGRAMS[mintProg] || window.RH4_PROGRAMS.echo);
    const data = encodeMint(prog.slots, labelHex, tickerHex, logoURI, liqBps, spanSeconds * 10);

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
            rpcUrls: [CFG().rpc], blockExplorerUrls: [CFG().explorer],
          }] });
        } else throw e;
      }

      say("checking the mint…");
      await rpc("eth_call", [{ from: account, to: CFG().factory, data }, "latest"]);

      say("confirm in your wallet…");
      const hash = await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: CFG().factory, data }],
      });

      say(`sent — ${hash.slice(0, 10)}… waiting for the chain`);
      let receipt = null;
      for (let i = 0; i < 60 && !receipt; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        receipt = await rpc("eth_getTransactionReceipt", [hash]);
      }
      if (!receipt) throw new Error("still pending — check the explorer");
      if (receipt.status !== "0x1") throw new Error("the mint reverted");

      const minted = (receipt.logs || []).find((l) => l.topics && l.topics[0] === TOPIC_MINTED);
      const id = minted ? Number(BigInt(minted.topics[1])) : null;
      btn.textContent = id ? `CHIP #${id} MINTED ✓` : "CHIP MINTED ✓";
      btn.style.background = "var(--mint-deep)";
      say(`${name} (${ticker}) is alive — its token exists, its clock is waiting. ` +
        `See it: ${CFG().explorer}/tx/${hash}`);
      loadGallery(); // il tuo chip appare subito in cima
    } catch (e) {
      say(short(e), true);
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- upload

  function buildUpload() {
    const drop = $("#f-drop"), input = $("#f-file"),
          thumb = $("#f-thumb"), text = $("#f-drop-text"), note = $("#f-logo-note");
    if (!drop) return;
    const tell = (msg, cls) => { note.textContent = msg; note.className = "field-note " + (cls || ""); };

    const accept = async (file) => {
      if (!file) return;
      if (file.size > 1024 * 1024) { tell("too big — 1 MB max", "is-bad"); return; }
      thumb.src = URL.createObjectURL(file);
      thumb.hidden = false; text.hidden = true; drop.classList.add("is-set");
      tell("pinning to IPFS…", "busy");
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/pin", { method: "POST", body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        logoURI = data.uri;
        tell(data.uri);
      } catch (e) {
        logoURI = "";
        tell(`upload failed: ${e.message}`, "is-bad");
      }
    };

    drop.addEventListener("click", () => input.click());
    input.addEventListener("change", () => accept(input.files[0]));
    for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-over"); });
    for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("is-over"); });
    drop.addEventListener("drop", (e) => accept(e.dataTransfer?.files?.[0]));
  }

  // ------------------------------------------------------------------ init

  function init() {
    wireChips("[data-liq]", (b) => { liqBps = Number(b.dataset.liq); });
    wireChips("[data-span]", (b) => { spanSeconds = Number(b.dataset.span); });
    wireChips("[data-mintprog]", (b) => { mintProg = b.dataset.mintprog; });
    wireChips("[data-pair]", (b) => { pair = b.dataset.pair; });
    drawEmission();
    buildUpload();
    loadGallery();
    setInterval(loadGallery, 30000); // la galleria respira da sola

    const tickerEl = $("#f-ticker");
    let debounce;
    tickerEl.addEventListener("input", () => {
      const cleaned = safeTicker(tickerEl.value);
      if (cleaned !== tickerEl.value) tickerEl.value = cleaned;
      clearTimeout(debounce);
      if (!cleaned) return;
      debounce = setTimeout(async () => {
        try {
          const hex = b32(cleaned);
          const taken = BigInt(await call(SELECTOR_BYTICKER + hex)) !== 0n;
          const note = $("#f-ticker-note");
          note.textContent = taken ? `${cleaned} is taken — forever` : `${cleaned} is free`;
          note.classList.toggle("is-bad", taken);
        } catch (_) {}
      }, 500);
    });

    const btn = $("#f-mint");
    let preview = false;
    try { preview = localStorage.getItem("rh4_launchpad") === "open"; } catch (_) {}
    if (btn && (CFG().launchpadOpen || preview) && window.RH4_PROGRAMS) {
      btn.disabled = false;
      btn.textContent = "MINT — LAUNCH CHIP & TOKEN";
      btn.addEventListener("click", () => walletMint(btn));
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
