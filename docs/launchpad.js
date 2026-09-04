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
  const SELECTOR_MINTPRICE = "0x6817c76c"; // mintPrice()
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

  /** La label di un chip e' bytes32 LIBERI sul contratto: chiunque puo'
   *  scriverci dentro dell'HTML. Qui si spegne, sempre, prima di innerHTML. */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

  /** Tante letture, UNA richiesta HTTP: l'RPC accetta i batch JSON-RPC. */
  async function rpcBatch(reqs) {
    const res = await fetch(CFG().rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(reqs.map((r, i) => ({ jsonrpc: "2.0", id: i, ...r }))),
    });
    const out = await res.json();
    const byId = new Map(out.map((r) => [r.id, r]));
    return reqs.map((_, i) => {
      const r = byId.get(i);
      if (!r || r.error) throw new Error((r && r.error.message) || "batch error");
      return r.result;
    });
  }

  // ------------------------------------------------------------ la galleria

  function chipCard(id, c, s, logoURI) {
    const running = !s.halted;
    const stalled = running && s.behindBlocks > 600; // ~1 minuto senza tick
    const badge = s.halted ? ["HALTED", "halt"] : stalled ? ["IDLE", "stall"] : ["RUNNING", "run"];
    const leds = Array.from({ length: 8 }, (_, i) =>
      `<div class="gled${(s.out >> (7 - i)) & 1 ? " on" : ""}"></div>`).join("");
    const logo = logoURI
      ? `<img class="glogo" src="${logoURI.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")}" alt="" loading="lazy"
           onerror="if(!this.dataset.r){this.dataset.r=1;this.src=this.src.replace('ipfs.io/ipfs','gateway.pinata.cloud/ipfs')}else{this.hidden=true}">`
      : "";
    const href = `chip.html?id=${id}`;

    const el = document.createElement("a");
    el.className = "gchip";
    el.href = href;
    el.innerHTML =
      `<div class="row1"><span class="tick">${esc(c.ticker || "?")}</span>${logo}` +
      `<span class="badge ${badge[1]}">${badge[0]}</span></div>` +
      `<div class="name">#${id} · ${esc(c.label || "unnamed")}</div>` +
      `<div class="gleds">${leds}</div>` +
      `<div class="grow"><span>CYCLES <b>${s.cycles.toLocaleString("en-US")}</b></span>` +
      `<span>OUT <b>${s.out}</b></span><span>PC <b>0x${s.pc.toString(16).padStart(3, "0")}</b></span></div>`;
    return el;
  }

  let lastGallery = "";
  function renderGallery(items, total) {
    const host = $("#gal");
    const key = JSON.stringify(items);
    if (key === lastGallery) return; // niente flicker se nulla e' cambiato
    lastGallery = key;
    $("#gal-count").textContent = `${total} CHIP${total === 1 ? "" : "S"} MINTED`;
    host.innerHTML = "";
    for (const it of items) host.appendChild(chipCard(it.id, it.c, it.s, it.logoURI));
  }

  async function loadGallery() {
    const host = $("#gal");
    if (!host) return;
    try {
      const ecall = (data) => ({ method: "eth_call", params: [{ to: CFG().factory, data }, "latest"] });
      const [nowHex, totalHex] = await rpcBatch([
        { method: "eth_blockNumber", params: [] }, ecall(SELECTOR_TOTAL),
      ]);
      const total = Number(BigInt(totalHex));
      const nowBlock = BigInt(nowHex);

      const ids = [];
      for (let id = total; id >= 1; id--) ids.push(id);
      const reqs = [];
      for (const id of ids) {
        reqs.push(ecall(SELECTOR_CHIP + word(id)), ecall(SELECTOR_INSPECT + word(id)), ecall(SELECTOR_LOGO + word(id)));
      }
      const res = await rpcBatch(reqs); // tutta la fabbrica in un giro solo

      const w = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
      const items = ids.map((id, k) => {
        const chipHex = res[k * 3], insHex = res[k * 3 + 1], logoHex = res[k * 3 + 2];
        const c = {
          label: b32ToString(w(chipHex, 1)),
          ticker: b32ToString(w(chipHex, 2)),
          token: "0x" + w(chipHex, 6).slice(24),
        };
        const s2 = {
          pc: Number(BigInt("0x" + w(insHex, 0))),
          out: Number(BigInt("0x" + w(insHex, 1))),
          halted: BigInt("0x" + w(insHex, 2)) === 1n,
          cycles: Number(BigInt("0x" + w(insHex, 3))),
          behindBlocks: Number(nowBlock - BigInt("0x" + w(insHex, 4))),
        };
        let logoURI = "";
        try {
          const len = Number(BigInt("0x" + w(logoHex, 1)));
          if (len > 0) {
            const raw = logoHex.slice(2 + 128, 2 + 128 + len * 2);
            logoURI = decodeURIComponent(raw.replace(/(..)/g, "%$1"));
          }
        } catch (_) {}
        return { id, c, s: s2, logoURI };
      });

      renderGallery(items, total);
      try { sessionStorage.setItem("rh4_gal", JSON.stringify({ items, total })); } catch (_) {}
    } catch (e) {
      if (!lastGallery) $("#gal-count").textContent = "the factory did not answer — refresh";
    }
  }

  // ------------------------------------------------------------- il calcolo

  let liqBps = 2000;
  let spanSeconds = 7776000;
  let mintProg = "echo";
  let pair = "weth";
  let logoURI = "";

  // il gas si legge dalla chain, non da una costante: il break-even del
  // mining vive o muore con questo numero
  const GAS_PER_TICK = 256740;
  let gasGwei = null;
  async function refreshGas() {
    try {
      gasGwei = Number(BigInt(await rpc("eth_gasPrice", []))) / 1e9;
      drawEmission();
    } catch (_) {}
  }

  function drawEmission() {
    const host = $("#f-emission");
    if (!host) return;
    const SUPPLY = 1e9;
    const cycles = spanSeconds * 10;
    const reserve = SUPPLY * (1 - liqBps / 10000);
    const perCycle = reserve / cycles;
    const fmt = (n) => Math.round(n).toLocaleString("en-US");
    let beRow = "", beNote = "";
    if (gasGwei) {
      const ethPerTick = GAS_PER_TICK * gasGwei * 1e-9;
      const be = ethPerTick * (SUPPLY / perCycle);
      const tick = safeTicker($("#f-ticker") ? $("#f-ticker").value : "") || "your token";
      beRow = `<div class="em-row"><span>MINING PAYS ABOVE</span><b>&asymp; ${fmt(be)} ETH FDV</b></div>`;
      beNote =
        `<div class="em-break">Mining pays for itself once ${esc(tick)} is worth about ` +
        `<b>${fmt(be)} ETH</b> fully diluted, at today&rsquo;s gas. Below that line every ` +
        `tick is sponsorship: one byte engraved forever, tokens earned at a loss.</div>`;
    }
    // 0% e' una scelta seria, non un incidente: niente mercato alla nascita
    const fairNote = liqBps === 0
      ? `<div class="em-break"><b>0% = pure fair launch.</b> No market at birth — every single ` +
        `token must be mined, one cycle at a time. Anyone holding mined tokens can open ` +
        `the market later from the chip&rsquo;s page.</div>`
      : "";
    host.innerHTML =
      `<div class="em-row"><span>TO LIQUIDITY</span><b>${fmt(SUPPLY - reserve)}</b></div>` +
      `<div class="em-row"><span>EARNED BY CYCLES</span><b>${fmt(reserve)}</b></div>` +
      `<div class="em-row"><span>PER CLOCK CYCLE</span><b>${perCycle.toFixed(2)}</b></div>` +
      beRow +
      `<div class="em-row"><span>TRADES AGAINST</span><b>${pair.toUpperCase()}</b></div>` +
      beNote + fairNote;
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

  // ---------------------------------------------------- i link del chip

  const S_SETLINKS = "0xdeb711de"; // setLinks(uint256,string,string,string)
  /** vuoto, oppure https:// in ASCII pulito — la stessa regola del contratto */
  const linkOk = (s) => s === "" || /^https:\/\/[\x21-\x7e]{1,152}$/.test(s) && !/["'<>\\]/.test(s);
  const readLinks = () => ["#f-x", "#f-web", "#f-tg"].map((id) => ($(id) ? $(id).value.trim() : ""));

  function encStrings(strs) {
    const parts = strs.map((s) => {
      const bytes = new TextEncoder().encode(s);
      let hex = "";
      for (const b of bytes) hex += b.toString(16).padStart(2, "0");
      return word(bytes.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64 || 0, "0");
    });
    return parts;
  }
  function encSetLinks(id, x, web, tg) {
    const parts = encStrings([x, web, tg]);
    let off = 4 * 32, offs = "";
    for (const p of parts) { offs += word(off); off += p.length / 2; }
    return S_SETLINKS + word(id) + offs + parts.join("");
  }

  async function walletSetLinks(btn, id, x, web, tg) {
    const provider = window.ethereum;
    if (!provider) { say("no wallet found in this browser", true); return; }
    btn.disabled = true;
    try {
      const [account] = await provider.request({ method: "eth_requestAccounts" });
      say("links: confirm in your wallet…");
      const h = await provider.request({ method: "eth_sendTransaction", params: [{
        from: account, to: CFG().socials, data: encSetLinks(id, x, web, tg) }] });
      let r = null;
      for (let i = 0; i < 40 && !r; i++) { await new Promise((z) => setTimeout(z, 2500)); r = await rpc("eth_getTransactionReceipt", [h]); }
      if (!r || r.status !== "0x1") throw new Error("links not written — check the explorer");
      btn.textContent = "LINKS ON-CHAIN ✓";
      btn.style.background = "var(--mint-deep)";
      say(`links written — they show on chip #${id}'s page. Only you can change them.`);
    } catch (e) {
      say(short(e), true);
      btn.disabled = false;
    }
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

    const [lx, lweb, ltg] = readLinks();
    if (![lx, lweb, ltg].every(linkOk)) { say("links must be https:// with no spaces or quotes", true); return; }

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
      // il prezzo del conio si legge dal contratto: se un domani si accende
      // il mintFee, il form continua a funzionare senza toccare nulla
      const price = BigInt(await call(SELECTOR_MINTPRICE));
      const value = price > 0n ? "0x" + price.toString(16) : undefined;
      await rpc("eth_call", [{ from: account, to: CFG().factory, data, ...(value && { value }) }, "latest"]);

      say("confirm in your wallet…");
      const hash = await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: CFG().factory, data, ...(value && { value }) }],
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

      // i link, se ne ha messi: una seconda firma, incisa accanto al chip
      if (id && CFG().socials && (lx || lweb || ltg)) {
        const lbtn = document.createElement("button");
        lbtn.className = "btn btn-light btn-block";
        lbtn.style.marginTop = "10px";
        lbtn.textContent = `ADD LINKS TO CHIP #${id}`;
        btn.parentNode.insertBefore(lbtn, btn.nextSibling);
        lbtn.addEventListener("click", () => walletSetLinks(lbtn, id, lx, lweb, ltg));
      }

      // il passo due: aprire il mercato, con la LP che nasce gia' bruciata
      if (id && liqBps > 0) {
        const emiHex = await rpc("eth_call", [{ to: CFG().factory, data: S_EMISSION + word(id) }, "latest"]);
        const tokenAddr = "0x" + emiHex.slice(2 + 24, 2 + 64);
        const mbtn = document.createElement("button");
        mbtn.className = "btn btn-dark btn-block";
        mbtn.style.marginTop = "10px";
        mbtn.textContent = "OPEN THE MARKET — LP SEALED, FEES SPLIT 50/50";
        btn.parentNode.insertBefore(mbtn, btn.nextSibling);
        mbtn.addEventListener("click", () => walletOpenMarket(mbtn, tokenAddr, pair));
      }
    } catch (e) {
      say(short(e), true);
      btn.disabled = false;
    }
  }


  // ------------------------------------------------- il mercato, LP bruciata

  const UNI = {
    NPM: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    V3F: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    DEAD: "0x000000000000000000000000000000000000dEaD",
    VAULT: () => CFG().creatorVault || CFG().feeVault || "0x000000000000000000000000000000000000dEaD",
    FEE: 10000, SPACING: 200,
    FDV_START: 5, FDV_END: 50, SUPPLY: 1e9,
  };
  const S_APPROVE = "0x095ea7b3", S_ALLOW = "0xdd62ed3e", S_BAL = "0x70a08231",
        S_GETPOOL = "0x1698ee82", S_CREATE = "0x13ead562", S_MINTPOS = "0x88316456",
        S_MULTI = "0xac9650d8", S_SLOT0 = "0x3850c7bd", S_EMISSION = "0x58292a3d";

  const addrWord = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  const intWord = (v) => { let b = BigInt(v); if (b < 0n) b += 1n << 256n; return b.toString(16).padStart(64, "0"); };

  /** TickMath.getSqrtRatioAtTick, identico al contratto Uniswap. */
  function sqrtRatioAtTick(tick) {
    const abs = BigInt(Math.abs(tick));
    const Q128 = 1n << 128n;
    let ratio = (abs & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
    const muls = [
      [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
      [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
      [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
      [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
      [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
      [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
      [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
      [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
      [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
      [0x80000n, 0x48a170391f7dc42444e8fa2n],
    ];
    for (const [bit, m] of muls) if ((abs & bit) !== 0n) ratio = (ratio * m) >> 128n;
    if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
    const shifted = ratio >> 32n;
    return shifted + (ratio % (1n << 32n) === 0n ? 0n : 1n);
  }
  const tickAtPrice = (p) => Math.floor(Math.log(p) / Math.log(1.0001));
  const floorSpacing = (t, s2) => Math.floor(t / s2) * s2;

  /** Quanto vale 1 NVDA in ETH: dal pool NVDA/WETH piu' fondo. */
  async function ethPerQuote(quote) {
    let best = null;
    for (const fee of [500, 3000, 10000]) {
      const [t0, t1] = quote.toLowerCase() < UNI.WETH.toLowerCase() ? [quote, UNI.WETH] : [UNI.WETH, quote];
      const pool = "0x" + (await rpc("eth_call", [{ to: UNI.V3F,
        data: S_GETPOOL + addrWord(t0) + addrWord(t1) + intWord(fee) }, "latest"])).slice(26);
      if (pool === "0x" + "0".repeat(40)) continue;
      const depth = BigInt(await rpc("eth_call", [{ to: UNI.WETH, data: S_BAL + addrWord(pool) }, "latest"]));
      if (!best || depth > best.depth) best = { pool, depth, t0 };
    }
    if (!best || best.depth < 5n * 10n ** 16n) throw new Error("no usable NVDA/WETH pool — open vs WETH instead");
    const slot0 = await rpc("eth_call", [{ to: best.pool, data: S_SLOT0 }, "latest"]);
    const sqrtX96 = BigInt("0x" + slot0.slice(2, 66));
    const price = Number(sqrtX96) ** 2 / 2 ** 192; // token1 per token0
    return best.t0.toLowerCase() === UNI.WETH.toLowerCase() ? 1 / price : price;
  }

  async function walletOpenMarket(btn, token, pairKey) {
    const provider = window.ethereum;
    if (!provider) { say("no wallet found in this browser", true); return; }
    btn.disabled = true;
    try {
      const [account] = await provider.request({ method: "eth_requestAccounts" });

      const balance = BigInt(await rpc("eth_call", [{ to: token, data: S_BAL + addrWord(account) }, "latest"]));
      if (balance === 0n) throw new Error("no liquidity slice in this wallet");

      const quote = pairKey === "nvda" ? UNI.NVDA : UNI.WETH;
      const rate = pairKey === "nvda" ? await ethPerQuote(quote) : 1;

      const ourIsToken0 = token.toLowerCase() < quote.toLowerCase();
      const [t0, t1] = ourIsToken0 ? [token, quote] : [quote, token];
      const qStart = UNI.FDV_START / rate, qEnd = UNI.FDV_END / rate;
      let lo, hi, init;
      if (ourIsToken0) {
        lo = floorSpacing(tickAtPrice(qStart / UNI.SUPPLY), UNI.SPACING);
        hi = floorSpacing(tickAtPrice(qEnd / UNI.SUPPLY), UNI.SPACING);
        if (hi <= lo) hi = lo + UNI.SPACING;
        init = lo;
      } else {
        lo = floorSpacing(tickAtPrice(UNI.SUPPLY / qEnd), UNI.SPACING);
        hi = floorSpacing(tickAtPrice(UNI.SUPPLY / qStart), UNI.SPACING);
        if (hi <= lo) hi = lo + UNI.SPACING;
        init = hi;
      }
      const sqrtX96 = sqrtRatioAtTick(init);

      // 1/2 — approve, solo se serve
      const allowance = BigInt(await rpc("eth_call", [{ to: token,
        data: S_ALLOW + addrWord(account) + addrWord(UNI.NPM) }, "latest"]));
      if (allowance < balance) {
        say("1/2 — approve in your wallet…");
        const h1 = await provider.request({ method: "eth_sendTransaction", params: [{
          from: account, to: token,
          data: S_APPROVE + addrWord(UNI.NPM) + balance.toString(16).padStart(64, "0"),
        }] });
        let r1 = null;
        for (let i = 0; i < 40 && !r1; i++) { await new Promise((r) => setTimeout(r, 2500)); r1 = await rpc("eth_getTransactionReceipt", [h1]); }
        if (!r1 || r1.status !== "0x1") throw new Error("approve failed");
      }

      // 2/2 — createAndInitialize + mint con recipient = inceneritore
      say("2/2 — open the market: confirm in your wallet…");
      const createCall = S_CREATE + addrWord(t0) + addrWord(t1) + intWord(UNI.FEE) + sqrtX96.toString(16).padStart(64, "0");
      const deadline = Math.floor(Date.now() / 1000) + 1800;
      const mintCall = S_MINTPOS +
        addrWord(t0) + addrWord(t1) + intWord(UNI.FEE) + intWord(lo) + intWord(hi) +
        (ourIsToken0 ? balance : 0n).toString(16).padStart(64, "0") +
        (ourIsToken0 ? 0n : balance).toString(16).padStart(64, "0") +
        intWord(0) + intWord(0) +
        addrWord(UNI.VAULT()) +              // la posizione nasce nel vault: fee alla riserva
        intWord(deadline);
      // multicall(bytes[]) con due chiamate
      const enc = (hex) => {
        const body = hex.replace("0x", "");
        const len = body.length / 2;
        return intWord(len) + body.padEnd(Math.ceil(body.length / 64) * 64, "0");
      };
      const c1 = enc(createCall), c2 = enc(mintCall);
      const off1 = 64, off2 = 64 + c1.length / 2;
      const data = S_MULTI + intWord(32) + intWord(2) + intWord(off1) + intWord(off2) + c1 + c2;

      const h2 = await provider.request({ method: "eth_sendTransaction",
        params: [{ from: account, to: UNI.NPM, data }] });
      say(`market opening — ${h2.slice(0, 10)}… waiting`);
      let r2 = null;
      for (let i = 0; i < 60 && !r2; i++) { await new Promise((r) => setTimeout(r, 2500)); r2 = await rpc("eth_getTransactionReceipt", [h2]); }
      if (!r2 || r2.status !== "0x1") throw new Error("market open reverted — check the explorer");

      const pool = "0x" + (await rpc("eth_call", [{ to: UNI.V3F,
        data: S_GETPOOL + addrWord(t0) + addrWord(t1) + intWord(UNI.FEE) }, "latest"])).slice(26);
      btn.textContent = "MARKET OPEN — LP SEALED ✓";
      btn.style.background = "var(--mint-deep)";
      say(`the LP is sealed — nobody can ever pull it. Half the 1% fees go to you forever; the rest feeds the reserve and buys back RH4. ` +
        `Pool: ${CFG().explorer}/address/${pool}`);
      loadGallery();
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
    refreshGas();
    setInterval(refreshGas, 60000);
    buildUpload();
    try {
      const cached = JSON.parse(sessionStorage.getItem("rh4_gal") || "null");
      if (cached) renderGallery(cached.items, cached.total); // subito, poi si aggiorna
    } catch (_) {}
    loadGallery();
    setInterval(loadGallery, 30000); // la galleria respira da sola

    const tickerEl = $("#f-ticker");
    let debounce;
    tickerEl.addEventListener("input", () => {
      const cleaned = safeTicker(tickerEl.value);
      if (cleaned !== tickerEl.value) tickerEl.value = cleaned;
      drawEmission(); // la frase del break-even chiama il token per nome
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

    // i link si controllano mentre li scrivi, e senza registro restano nascosti
    for (const id of ["#f-x", "#f-web", "#f-tg"]) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener("input", () => el.classList.toggle("is-bad", !linkOk(el.value.trim())));
    }
    if (!CFG().socials) {
      const lf = $("#f-x") && $("#f-x").closest(".field");
      if (lf) lf.hidden = true;
    }

    const btn = $("#f-mint");
    // l'invito per il collaudo privato: ?crew=<parola> apre il form solo su
    // questo browser, poi l'URL si ripulisce da solo. Il cancello vero e' il
    // flip di launchpadOpen: questo e' un passaggio sul retro, non la porta.
    try {
      const crew = new URLSearchParams(location.search).get("crew");
      if (crew === "tapeout-2368") {
        localStorage.setItem("rh4_launchpad", "open");
        history.replaceState(null, "", location.pathname);
      }
    } catch (_) {}
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
