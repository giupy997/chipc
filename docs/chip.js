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
        S_GETPOOL = "0x1698ee82", S_SLOT0 = "0x3850c7bd", S_BAL = "0x70a08231",
        S_APPROVE = "0x095ea7b3", S_ALLOW = "0xdd62ed3e",
        S_CREATE = "0x13ead562", S_MINTPOS = "0x88316456", S_MULTI = "0xac9650d8";
  const TOPIC_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

  const UNI = {
    NPM: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    V3F: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    DEAD: "0x000000000000000000000000000000000000dEaD",
    VAULT: () => CFG().feeVault || "0x000000000000000000000000000000000000dEaD",
    CVAULT: () => CFG().creatorVault || "0x000000000000000000000000000000000000dEaD",
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
      $("#cp-ca").hidden = false;
      $("#cp-ca-addr").textContent = state.token;
      $("#cp-ca-copy").onclick = async () => {
        try { await navigator.clipboard.writeText(state.token); } catch (_) {}
        $("#cp-ca-copy").textContent = "COPIED ✓";
        setTimeout(() => { $("#cp-ca-copy").textContent = "COPY"; }, 1500);
      };
    }

    // logo
    try {
      const len = Number(BigInt("0x" + w(logoHex, 1)));
      if (len > 0) {
        const raw = logoHex.slice(2 + 128, 2 + 128 + len * 2);
        const uri = decodeURIComponent(raw.replace(/(..)/g, "%$1"));
        const img = $("#cp-logo");
        img.onerror = () => {
          if (!img.dataset.r) { img.dataset.r = 1; img.src = img.src.replace("ipfs.io/ipfs", "gateway.pinata.cloud/ipfs"); }
          else img.src = "brand/icon4-256.png";
        };
        img.src = uri.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/");
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


  // ---------------------------------------- aprire il mercato (LP bruciata)

  const intWord = (v) => { let b = BigInt(v); if (b < 0n) b += 1n << 256n; return b.toString(16).padStart(64, "0"); };

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
  const floorSpacing = (t, sp) => Math.floor(t / sp) * sp;

  async function ethPerQuote(quote) {
    let best = null;
    for (const fee of [500, 3000, 10000]) {
      const [t0, t1] = quote.toLowerCase() < UNI.WETH.toLowerCase() ? [quote, UNI.WETH] : [UNI.WETH, quote];
      const pool = "0x" + (await call(UNI.V3F, S_GETPOOL + addrWord(t0) + addrWord(t1) + intWord(fee))).slice(26);
      if (pool === ZERO) continue;
      const depth = BigInt(await call(UNI.WETH, S_BAL + addrWord(pool)));
      if (!best || depth > best.depth) best = { pool, depth, t0 };
    }
    if (!best || best.depth < 5n * 10n ** 16n) throw new Error("no usable rate pool — open vs WETH instead");
    const slot0 = await call(best.pool, S_SLOT0);
    const sqrtX96 = BigInt("0x" + slot0.slice(2, 66));
    const p = Number(sqrtX96) ** 2 / 2 ** 192;
    return best.t0.toLowerCase() === UNI.WETH.toLowerCase() ? 1 / p : p;
  }

  async function walletOpenMarket(btn, pairKey, statusEl, feeMode) {
    const provider = window.ethereum;
    const tell = (m) => { statusEl.innerHTML = m; };
    if (!provider) { tell("no wallet found in this browser"); return; }
    btn.disabled = true;
    try {
      const [account] = await provider.request({ method: "eth_requestAccounts" });
      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG().chainIdHex }] });
      } catch (e) {
        if (e && e.code === 4902) {
          await provider.request({ method: "wallet_addEthereumChain", params: [{
            chainId: CFG().chainIdHex, chainName: CFG().chainName,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [CFG().rpc], blockExplorerUrls: [CFG().explorer] }] });
        } else throw e;
      }

      const balance = BigInt(await call(state.token, S_BAL + addrWord(account)));
      if (balance === 0n) throw new Error("this wallet holds no liquidity slice of this token");

      const quote = pairKey === "nvda" ? UNI.NVDA : UNI.WETH;
      const rate = pairKey === "nvda" ? await ethPerQuote(quote) : 1;
      const ourIsToken0 = state.token.toLowerCase() < quote.toLowerCase();
      const [t0, t1] = ourIsToken0 ? [state.token, quote] : [quote, state.token];
      const qStart = 5 / rate, qEnd = 50 / rate, SUP = 1e9, SPACING = 200;
      let lo, hi, init;
      if (ourIsToken0) {
        lo = floorSpacing(tickAtPrice(qStart / SUP), SPACING);
        hi = floorSpacing(tickAtPrice(qEnd / SUP), SPACING);
        if (hi <= lo) hi = lo + SPACING;
        init = lo;
      } else {
        lo = floorSpacing(tickAtPrice(SUP / qEnd), SPACING);
        hi = floorSpacing(tickAtPrice(SUP / qStart), SPACING);
        if (hi <= lo) hi = lo + SPACING;
        init = hi;
      }
      const sqrtX96 = sqrtRatioAtTick(init);

      const allowance = BigInt(await call(state.token, S_ALLOW + addrWord(account) + addrWord(UNI.NPM)));
      if (allowance < balance) {
        tell("1/2 — approve in your wallet…");
        const h1 = await provider.request({ method: "eth_sendTransaction", params: [{
          from: account, to: state.token,
          data: S_APPROVE + addrWord(UNI.NPM) + balance.toString(16).padStart(64, "0") }] });
        let r1 = null;
        for (let i = 0; i < 40 && !r1; i++) { await sleep(2500); r1 = await rpc("eth_getTransactionReceipt", [h1]); }
        if (!r1 || r1.status !== "0x1") throw new Error("approve failed");
      }

      tell("2/2 — open the market: confirm in your wallet…");
      const createCall = S_CREATE + addrWord(t0) + addrWord(t1) + intWord(UNI.FEE) + sqrtX96.toString(16).padStart(64, "0");
      const deadline = Math.floor(Date.now() / 1000) + 1800;
      const mintCall = S_MINTPOS +
        addrWord(t0) + addrWord(t1) + intWord(UNI.FEE) + intWord(lo) + intWord(hi) +
        (ourIsToken0 ? balance : 0n).toString(16).padStart(64, "0") +
        (ourIsToken0 ? 0n : balance).toString(16).padStart(64, "0") +
        intWord(0) + intWord(0) +
        addrWord(feeMode === "creator" ? UNI.CVAULT() : feeMode === "vault" ? UNI.VAULT() : UNI.DEAD) + intWord(deadline);
      const enc = (hex) => {
        const body = hex.replace("0x", "");
        return intWord(body.length / 2) + body.padEnd(Math.ceil(body.length / 64) * 64, "0");
      };
      const c1 = enc(createCall), c2 = enc(mintCall);
      const data = S_MULTI + intWord(32) + intWord(2) + intWord(64) + intWord(64 + c1.length / 2) + c1 + c2;

      const h2 = await provider.request({ method: "eth_sendTransaction",
        params: [{ from: account, to: UNI.NPM, data }] });
      tell(`market opening — ${h2.slice(0, 10)}… waiting`);
      let r2 = null;
      for (let i = 0; i < 60 && !r2; i++) { await sleep(2500); r2 = await rpc("eth_getTransactionReceipt", [h2]); }
      if (!r2 || r2.status !== "0x1") throw new Error("market open reverted — check the explorer");

      tell(feeMode === "creator"
        ? "market open — LP sealed: fees split 50/50, creator and reserve ✓"
        : feeMode === "vault"
        ? "market open — the LP is sealed in the vault: fees will feed the reserve ✓"
        : "market open — the LP position was born at the burn address ✓");
      setTimeout(() => location.reload(), 2500);
    } catch (e) {
      tell(short(e));
      btn.disabled = false;
    }
  }


  /** La posizione di questo pool sta nel vault? Allora chiunque puo'
   *  spazzare le fee nella riserva: il bottone e' un servizio pubblico. */
  async function detectVaulted() {
    for (const [vault, label] of [[CFG().creatorVault, "CREATOR 50/50"], [CFG().feeVault, "VAULTED"]]) {
      if (vault && await _detectIn(vault, label)) return;
    }
  }
  async function _detectIn(vault, label) {
    const n = Number(BigInt(await call(UNI.NPM, "0x70a08231" + addrWord(vault))));
    for (let i = 0; i < Math.min(n, 50); i++) {
      const tid = BigInt(await call(UNI.NPM, "0x2f745c59" + addrWord(vault) + intWord(i)));
      const pos = await call(UNI.NPM, "0x99fbab88" + intWord(tid));
      const w2 = (k) => "0x" + pos.slice(2 + k * 64 + 24, 2 + (k + 1) * 64);
      const t0 = w2(2), t1 = w2(3);
      const ours = [t0.toLowerCase(), t1.toLowerCase()];
      if (ours.includes(state.token.toLowerCase()) && ours.includes(state.quote.toLowerCase())) {
        $("#cp-lp").textContent = label;
        const head = $(".cp-mhead");
        const b = document.createElement("button");
        b.className = "btn btn-light btn-sm";
        b.textContent = label === "VAULTED" ? "SWEEP FEES → RESERVE" : "SWEEP FEES 50/50";
        b.style.marginLeft = "8px";
        b.onclick = async () => {
          const provider = window.ethereum;
          if (!provider) return;
          b.disabled = true;
          try {
            const [account] = await provider.request({ method: "eth_requestAccounts" });
            const h = await provider.request({ method: "eth_sendTransaction", params: [{
              from: account, to: vault, data: "0xce3f865f" + intWord(tid) }] });
            b.textContent = "SWEEPING…";
            let r = null;
            for (let k = 0; k < 40 && !r; k++) { await sleep(2500); r = await rpc("eth_getTransactionReceipt", [h]); }
            b.textContent = r && r.status === "0x1" ? "FEES SWEPT ✓" : "SWEEP FAILED";
          } catch (_) { b.textContent = "SWEEP FEES → RESERVE"; b.disabled = false; }
        };
        head.appendChild(b);
        return true;
      }
    }
    return false;
  }

  async function loadMarket() {
    const found = await findPool();
    if (!found) {
      $("#chart").hidden = true;
      const nm = $("#cp-nomarket");
      nm.hidden = false;
      if (id === 1) {
        nm.innerHTML = `the mother trades on <a href="https://www.ponsfamily.com/launchpad/${state.token}">pons</a> — chart and trades live there`;
      } else {
        nm.innerHTML = `no market yet.<br><br>` +
          `<span style="font-size:11px;letter-spacing:0.12em;font-weight:700">TRADING FEES — chosen once, sealed forever</span><br>` +
          `<button class="btn btn-light btn-sm" id="cp-fee-creator" style="border-width:2px">&#10003; 50% CREATOR / 50% RESERVE</button> ` +
          `<button class="btn btn-light btn-sm" id="cp-fee-vault" style="opacity:.55">100% RESERVE</button> ` +
          `<button class="btn btn-light btn-sm" id="cp-fee-burn" style="opacity:.55">BURNED</button>` +
          `<br><br>` +
          `<button class="btn btn-dark btn-sm" id="cp-open-weth">OPEN VS WETH</button> ` +
          `<button class="btn btn-dark btn-sm" id="cp-open-nvda">OPEN VS NVDA</button>` +
          `<br><br><span id="cp-open-note">the LP can never be pulled — it is born in the vault ` +
          `(or burned), not in a wallet. With the vault, anyone can sweep the 1% trading ` +
          `fees into this chip's mining reserve: volume extends the emission.</span>`;
        let feeMode = "creator";
        const syncFee = () => {
          const modes = { creator: "cp-fee-creator", vault: "cp-fee-vault", burn: "cp-fee-burn" };
          const labels = { creator: "50% CREATOR / 50% RESERVE", vault: "100% RESERVE", burn: "BURNED" };
          for (const [m, idEl] of Object.entries(modes)) {
            $("#" + idEl).style.opacity = feeMode === m ? "1" : ".55";
            $("#" + idEl).innerHTML = (feeMode === m ? "&#10003; " : "") + labels[m];
          }
        };
        $("#cp-fee-creator").addEventListener("click", () => { feeMode = "creator"; syncFee(); });
        $("#cp-fee-vault").addEventListener("click", () => { feeMode = "vault"; syncFee(); });
        $("#cp-fee-burn").addEventListener("click", () => { feeMode = "burn"; syncFee(); });
        $("#cp-open-weth").addEventListener("click", (e) =>
          walletOpenMarket(e.target, "weth", $("#cp-open-note"), feeMode));
        $("#cp-open-nvda").addEventListener("click", (e) =>
          walletOpenMarket(e.target, "nvda", $("#cp-open-note"), feeMode));
      }
      $("#cp-price").textContent = "—";
      return;
    }
    Object.assign(state, found);

    // LP bruciata? la posizione appartiene all'inceneritore se il flusso e' il nostro
    // (indicatore semplice: il pool esiste -> mostriamo il fee tier; il burn si
    //  dichiara nei trades del minter, verificabile dall'explorer)
    $("#cp-lp").textContent = "1% FEE";
    detectVaulted().catch(() => {});
    const dex = $("#cp-dex");
    dex.href = `https://dexscreener.com/robinhood/${state.pool}`;
    dex.hidden = false;

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
    // tutti i range in UN batch: una richiesta HTTP per l'intera storia
    const ranges = [];
    for (let from = state.bornBlock || 1; from <= now; from += CHUNK) {
      ranges.push({ method: "eth_getLogs", params: [{
        address: state.pool, topics: [TOPIC_SWAP],
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + Math.min(from + CHUNK - 1, now).toString(16) }] });
    }
    let gaps = 0;
    try {
      const parts = await (async () => {
        const res = await fetch(CFG().rpc, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(ranges.map((r, i) => ({ jsonrpc: "2.0", id: i, ...r }))),
        }).then((x) => x.json());
        const byId = new Map(res.map((r) => [r.id, r]));
        return ranges.map((_, i) => {
          const r = byId.get(i);
          if (!r || r.error) { gaps++; return []; }
          return r.result;
        });
      })();
      logs = parts.flat();
    } catch (_) {
      // il batch intero e' caduto: si torna alle fette una alla volta
      for (const rng of ranges) {
        try { logs = logs.concat(await rpc(rng.method, rng.params, 6)); }
        catch (_) { gaps++; }
        await sleep(200);
      }
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
