/**
 * memory.js — le memory card (RH4Memory): NFT con dentro i byte.
 *
 * Il cancello e' config.js: `memory` vuoto = porta chiusa. Tutto passa da
 * eth_call sul nodo pubblico, niente backend: le firme le mette il wallet
 * del browser. Con `?dev&rpc=...&memory=0x...` nell'URL si punta a un fork
 * locale, per provare prima del deploy.
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const Q = new URLSearchParams(location.search);
  const DEV = Q.has("dev");
  const CFG = () => window.RH4_CONFIG || {};
  const RPC = () => (DEV && Q.get("rpc")) || CFG().rpc;
  const MEM = () => (DEV && Q.get("memory")) || CFG().memory || "";
  const RH4 = () => CFG().token;

  // ---- il contratto, in selettori --------------------------------------------
  const S = {
    kinds: "0x1be40a49", kindCount: "0x080bfdeb", totalCards: "0xe994c15d",
    ownerOf: "0x6352211e", card: "0xbfcfd9b9", read: "0xdcd1749b", readAll: "0xff9847e7",
    mint: "0x1801fbe5", write: "0x396e9b3a", seal: "0x86fe212d", clear: "0xc0fe1af8",
    setName: "0xfe55932a", setContent: "0x6c39bf8b", nameOf: "0x051a2664", contentOf: "0x27427e31",
    tokenURI: "0xc87b56dd", balanceOf: "0x70a08231", allowance: "0xdd62ed3e", approve: "0x095ea7b3",
  };
  const ERRORS = {
    "0x723bccb7": "no such card size", "0xc3fbd20b": "this size is not on sale",
    "0x8f0f029b": "only the card's owner can do this", "0xf0ce59e6": "this card is sealed: it never changes again",
    "0xb4120f14": "out of the card's bounds", "0x36b0862f": "a pinned card holds a hash, not bytes",
    "0x25356491": "an on-chain card holds bytes, not a content hash", "0x153736cd": "a name is 3-32 of a-z, 0-9 and dash, not starting or ending with a dash",
    "0x57fc4d23": "that name belongs to another card", "0xf2d773a0": "no such card",
    "0xfb8f41b2": "not enough RH4 in the wallet", "0x7dc7a0d9": "not the owner",
  };

  // ---- rpc ------------------------------------------------------------------
  const word = (v) => { let b = BigInt(v); if (b < 0n) b += 1n << 256n; return b.toString(16).padStart(64, "0"); };
  const addrWord = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  const addrAt = (hex, i) => "0x" + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
  const wordAt = (hex, i) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  const bytesAt = (hex, i) => {   // dynamic bytes/string il cui offset sta nella parola i
    const off = Number(wordAt(hex, i)) / 32, len = Number(wordAt(hex, off));
    return hex.slice(2 + (off + 1) * 64, 2 + (off + 1) * 64 + len * 2);
  };
  const utf8 = (hexBody) => { const b = new Uint8Array(hexBody.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(hexBody.slice(i * 2, i * 2 + 2), 16); return b; };
  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const dec = (bytes) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const enc = (s) => new TextEncoder().encode(s);
  const b32str = (hex) => dec(utf8(hex.slice(2))).replace(/\0+$/, "");
  const strArg = (bytes) => word(bytes.length) + toHex(bytes).padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  const short = (e) => String((e && (e.message || e)) || "error").slice(0, 120);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtRh4 = (bi) => Number(bi / 10n ** 18n).toLocaleString("en-US");
  const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 ? 1 : 0) + " MB" : n >= 1024 ? (n / 1024).toFixed(n % 1024 ? 1 : 0) + " KB" : n + " B";

  function explain(err) {
    const data = err && (err.data || (err.error && err.error.data));
    const hex = typeof data === "string" ? data : data && data.data;
    if (typeof hex === "string" && ERRORS[hex.slice(0, 10)]) return ERRORS[hex.slice(0, 10)];
    const m = String((err && err.message) || "").match(/0x[0-9a-f]{8}/i);
    if (m && ERRORS[m[0].toLowerCase()]) return ERRORS[m[0].toLowerCase()];
    return (err && err.message) || "rpc error";
  }
  async function rpc(method, params, tries = 4) {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(RPC(), { method: "POST", headers: { "content-type": "application/json" },
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
      const res = await fetch(RPC(), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(slice.map((r, i) => ({ jsonrpc: "2.0", id: start + i, ...r }))) });
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [data];
      const byId = new Map(arr.map((r) => [r.id, r]));
      for (let i = 0; i < slice.length; i++) {
        const r = byId.get(start + i);
        out[start + i] = r && !r.error ? r.result : null;
      }
    }
    return out;
  }
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
  const ecall = (to, data) => ({ method: "eth_call", params: [{ to, data }, "latest"] });
  const mcall = (data) => call(MEM(), data);

  // ---- il wallet -------------------------------------------------------------
  const me = () => (window.RH4_WALLET && window.RH4_WALLET.address) || null;
  async function send(to, data, what) {
    const from = me() || await window.RH4_WALLET.connect();
    if (!from) throw new Error("connect a wallet first");
    if (DEV && Q.get("rpc")) {   // sul fork: chain diversa, il wallet deve gia' starci
    } else {
      try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG().chainIdHex }] }); } catch (_) {}
    }
    // simulazione prima della firma: un revert costa parole, non gas
    await rpc("eth_call", [{ from, to, data }, "latest"]);
    const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
    let r = null;
    for (let i = 0; i < 60 && !r; i++) { await sleep(2000); r = await rpc("eth_getTransactionReceipt", [hash]); }
    if (!r || r.status !== "0x1") throw new Error(`${what} failed — check the explorer`);
    return hash;
  }

  // ---- il cancello ----------------------------------------------------------------
  function gate() {
    if (!MEM()) {
      $("#mc-main").innerHTML =
        `<div class="cv-closed"><p class="pill"><span class="pill-n">FACTORY</span>MEMORY CARDS</p>` +
        `<h2>Not on sale yet.</h2>` +
        `<p>The memory card contract is written and tested, not deployed. ` +
        `Until then, the <a href="launchpad.html">launchpad</a> is where things are born.</p></div>`;
      return false;
    }
    if (DEV) { const b = $("#mc-banner"); b.hidden = false; b.innerHTML = `<b>DEV</b> &mdash; reading ${esc(MEM())} at ${esc(RPC())}`; }
    return true;
  }

  // ---- i tagli ------------------------------------------------------------------
  const st = { kinds: [], kind: -1, cards: [], open: null, hex: false, bytes: null };

  async function loadKinds() {
    const n = Number(wordAt(await mcall(S.kindCount), 0));
    const raw = await rpcBatch(Array.from({ length: n }, (_, i) => ecall(MEM(), S.kinds + word(i))));
    st.kinds = raw.map((r, i) => r ? {
      kind: i, capacity: Number(wordAt(r, 0)), onchain: wordAt(r, 1) === 1n, enabled: wordAt(r, 2) === 1n,
      price: wordAt(r, 3), name: dec(utf8(bytesAt(r, 4))),
    } : null).filter(Boolean);
    const host = $("#k-list");
    host.innerHTML = st.kinds.map((k) =>
      `<button class="kind${k.enabled ? "" : " is-off"}" data-kind="${k.kind}" type="button">` +
      `<div class="kn">${esc(k.name)}</div><div class="kp">${fmtRh4(k.price)} RH4</div>` +
      `<div class="kt">${k.onchain ? "ON-CHAIN" : "PINNED"}</div></button>`).join("") || `<span class="field-note">no sizes yet</span>`;
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-kind]"); if (!b) return;
      host.querySelectorAll(".kind").forEach((c) => c.classList.toggle("is-on", c === b));
      st.kind = Number(b.dataset.kind);
      drawPrice();
    });
    const first = st.kinds.find((k) => k.enabled);
    if (first) { host.querySelector(`[data-kind="${first.kind}"]`).classList.add("is-on"); st.kind = first.kind; drawPrice(); }
  }

  function drawPrice() {
    const k = st.kinds.find((x) => x.kind === st.kind);
    if (!k) return;
    $("#k-price").innerHTML = k.onchain
      ? `<b>${esc(k.name)}</b>: ${k.capacity.toLocaleString("en-US")} bytes of on-chain storage for <b>${fmtRh4(k.price)} RH4</b>. Write them one byte or one page at a time; every write is a transaction, every read is free.`
      : `<b>${esc(k.name)}</b>: a pinned card for <b>${fmtRh4(k.price)} RH4</b>. It holds the hash and the IPFS address of up to ${esc(k.name)}B of content, plus a unique name.`;
    $("#k-buy").disabled = false;
    $("#k-buy").textContent = `BUY ${k.name}`;
  }

  async function buy() {
    const k = st.kinds.find((x) => x.kind === st.kind); if (!k) return;
    const note = $("#k-buy-note"); const tell = (m, bad) => { note.hidden = !m; note.textContent = m || ""; note.classList.toggle("is-bad", !!bad); };
    const btn = $("#k-buy"); btn.disabled = true;
    try {
      const from = me() || await window.RH4_WALLET.connect();
      if (!from) throw new Error("connect a wallet first");
      const bal = wordAt(await call(RH4(), S.balanceOf + addrWord(from)), 0);
      if (bal < k.price) throw new Error(`you hold ${fmtRh4(bal)} RH4, a ${k.name} card costs ${fmtRh4(k.price)}`);
      const allowance = wordAt(await call(RH4(), S.allowance + addrWord(from) + addrWord(MEM())), 0);
      if (allowance < k.price) {
        tell("1/2 — approve the RH4 in your wallet…");
        await send(RH4(), S.approve + addrWord(MEM()) + word(k.price), "approve");
      }
      tell("signing the mint…");
      const label = enc(($("#k-label").value || "").trim()).slice(0, 32);
      const h = await send(MEM(), S.mint + word(k.kind) + toHex(label).padEnd(64, "0"), "mint");
      tell(`done — tx ${h.slice(0, 14)}…`);
      $("#k-label").value = "";
      await loadCards();
      const mine = st.cards.filter((c) => c.owner.toLowerCase() === from.toLowerCase());
      if (mine.length) openCard(mine[mine.length - 1].id);
    } catch (e) { tell(explain(e) === "rpc error" ? short(e) : explain(e), true); }
    btn.disabled = false;
  }

  // ---- le card -------------------------------------------------------------------
  async function loadCards() {
    const total = Number(wordAt(await mcall(S.totalCards), 0));
    $("#gal-count").textContent = `${total} MINTED`;
    if (!total) { $("#gal").innerHTML = `<div class="gal-empty">No card yet. The first one is still on the shelf.</div>`; st.cards = []; return; }
    const ids = Array.from({ length: total }, (_, i) => i + 1);
    const [owners, cards] = await Promise.all([
      rpcBatch(ids.map((id) => ecall(MEM(), S.ownerOf + word(id)))),
      rpcBatch(ids.map((id) => ecall(MEM(), S.card + word(id)))),
    ]);
    st.cards = ids.map((id, i) => {
      const c = cards[i]; if (!c || !owners[i]) return null;
      return { id, owner: addrAt(owners[i], 0), kind: Number(wordAt(c, 0)), locked: wordAt(c, 1) === 1n,
        used: Number(wordAt(c, 2)), born: Number(wordAt(c, 3)), writes: Number(wordAt(c, 4)), label: b32str("0x" + c.slice(2 + 5 * 64, 2 + 6 * 64)) };
    }).filter(Boolean);
    drawCards();
  }

  function kindOf(c) { return st.kinds.find((k) => k.kind === c.kind) || { name: "?", capacity: 0, onchain: true }; }

  function drawCards() {
    const my = me();
    const list = st.cards.slice().sort((a, b) => {
      const am = my && a.owner.toLowerCase() === my.toLowerCase(), bm = my && b.owner.toLowerCase() === my.toLowerCase();
      return am === bm ? b.id - a.id : am ? -1 : 1;
    });
    $("#gal-title").textContent = my ? "YOUR CARDS FIRST" : "CARDS";
    $("#gal").innerHTML = list.map((c) => {
      const k = kindOf(c), mine = my && c.owner.toLowerCase() === my.toLowerCase();
      return `<button class="mcard${st.open === c.id ? " is-on" : ""}" data-id="${c.id}" type="button" title="${esc(c.label || "")}">` +
        `<img data-uri="${c.id}" alt="">` +
        `<div class="mm"><b>#${c.id}</b><span>${esc(k.name)}${c.locked ? " ·SEALED" : mine ? " ·YOURS" : ""}</span></div></button>`;
    }).join("");
    // l'immagine della card la disegna il contratto (tokenURI): si carica dopo, a lotti
    loadArt();
  }

  async function loadArt() {
    const imgs = Array.from(document.querySelectorAll("img[data-uri]"));
    const uris = await rpcBatch(imgs.map((im) => ecall(MEM(), S.tokenURI + word(im.dataset.uri))));
    imgs.forEach((im, i) => {
      try {
        const json = JSON.parse(atob(dec(utf8(bytesAt(uris[i], 0))).replace(/^data:application\/json;base64,/, "")));
        im.src = json.image;
        im.dataset.json = "1";
      } catch (_) {}
    });
  }

  // ---- il lettore ------------------------------------------------------------------
  async function readBytes(c, k) {
    if (!c.used) return new Uint8Array(0);
    const CH = 8192;   // a pezzi: un readAll da 256 KB e' troppo per un eth_call pubblico
    const reqs = [];
    for (let off = 0; off < c.used; off += CH) reqs.push(ecall(MEM(), S.read + word(c.id) + word(off) + word(Math.min(CH, c.used - off))));
    const parts = await rpcBatch(reqs);
    const out = new Uint8Array(c.used); let at = 0;
    for (const p of parts) { if (!p) throw new Error("read failed"); const b = utf8(bytesAt(p, 0)); out.set(b, at); at += b.length; }
    return out;
  }

  async function openCard(id) {
    let c = st.cards.find((x) => x.id === id);
    if (!c) { await loadCards(); c = st.cards.find((x) => x.id === id); }
    if (!c) return;
    st.open = id; drawCards();
    const k = kindOf(c), my = me(), mine = my && c.owner.toLowerCase() === my.toLowerCase();
    const v = $("#viewer"); v.hidden = false;
    $("#v-title").textContent = `CARD #${id}`;
    $("#v-sub").textContent = `${k.name} · ${c.label || "no label"}`;
    const badge = $("#v-badge");
    badge.textContent = c.locked ? "SEALED" : mine ? "YOURS" : k.onchain ? "ON-CHAIN" : "PINNED";
    badge.className = "badge" + (c.locked ? " sealed" : mine ? " mine" : "");
    $("#v-uri").href = `${CFG().explorer}/token/${MEM()}/instance/${id}`;
    const pct = k.capacity ? Math.min(100, (c.used / k.capacity) * 100) : 0;
    let extra = "";
    if (!k.onchain) {
      const [co, nm] = await Promise.all([mcall(S.contentOf + word(id)), mcall(S.nameOf + word(id))]);
      const hash = "0x" + co.slice(2, 66), uri = dec(utf8(bytesAt(co, 1))), name = dec(utf8(bytesAt(nm, 0)));
      extra = `<div class="row"><span>NAME</span><b>${name ? esc(name) : "—"}</b></div>` +
        `<div class="row"><span>CONTENT</span><b>${uri ? `<a href="${esc(uri.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/"))}" target="_blank" rel="noopener">${esc(uri)}</a>` : "—"}</b></div>` +
        `<div class="row"><span>HASH</span><b>${/^0x0+$/.test(hash) ? "—" : hash.slice(0, 10) + "…" + hash.slice(-6)}</b></div>`;
      $("#p-uri").value = uri; $("#p-name").value = name;
    }
    $("#v-info").innerHTML =
      `<div class="row"><span>OWNER</span><b><a href="${CFG().explorer}/address/${c.owner}" target="_blank" rel="noopener">${mine ? "you" : c.owner.slice(0, 8) + "…" + c.owner.slice(-4)}</a></b></div>` +
      `<div class="row"><span>SIZE</span><b>${k.onchain ? fmtBytes(k.capacity) + " on-chain" : k.name + "B pinned"}</b></div>` +
      (k.onchain ? `<div class="row"><span>USED</span><b>${c.used.toLocaleString("en-US")} / ${k.capacity.toLocaleString("en-US")} bytes</b></div>` : "") +
      `<div class="row"><span>WRITES</span><b>${c.writes}</b></div>` +
      `<div class="row"><span>BORN</span><b><a href="${CFG().explorer}/block/${c.born}" target="_blank" rel="noopener">block ${c.born.toLocaleString("en-US")}</a></b></div>` +
      extra +
      (k.onchain ? `<div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div><span class="field-note">${pct.toFixed(1)}% full</span>` : "");
    // il contenuto
    const dump = $("#v-dump");
    if (k.onchain) {
      dump.textContent = c.used ? "reading…" : "";
      try { st.bytes = await readBytes(c, k); } catch (e) { st.bytes = null; dump.textContent = short(e); }
      drawDump(c, k);
    } else { st.bytes = null; dump.innerHTML = `<span class="zero">a pinned card: its content lives on IPFS, its hash and name here</span>`; }
    $("#v-write").hidden = !(k.onchain && mine && !c.locked);
    $("#v-pin").hidden = !(!k.onchain && mine && !c.locked);
    $("#w-off").value = String(c.used);
    $("#w-text").value = ""; sizeNote();
    $("#w-note").hidden = true; $("#p-note").hidden = true;
    v.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function drawDump(c, k) {
    const dump = $("#v-dump");
    dump.classList.toggle("hex", st.hex);
    if (!st.bytes) return;
    if (!st.bytes.length) { dump.innerHTML = `<span class="zero">blank — ${k.capacity.toLocaleString("en-US")} bytes of nothing, so far</span>`; return; }
    if (!st.hex) { dump.textContent = dec(st.bytes); return; }
    let out = "";
    for (let i = 0; i < st.bytes.length; i += 16) {
      const row = Array.from(st.bytes.slice(i, i + 16));
      const hx = row.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
      const as = row.map((b) => b >= 32 && b < 127 ? String.fromCharCode(b) : ".").join("");
      out += `${i.toString(16).padStart(6, "0")}  ${esc(hx)}  ${esc(as)}\n`;
    }
    dump.innerHTML = out;
  }

  function sizeNote() {
    const n = enc($("#w-text").value).length;
    const c = st.cards.find((x) => x.id === st.open); const k = c ? kindOf(c) : null;
    const off = Number($("#w-off").value || 0);
    const fits = k ? off + n <= k.capacity : true;
    $("#w-size").textContent = `${n} bytes${k ? ` → ends at ${off + n} of ${k.capacity}` : ""}`;
    $("#w-size").classList.toggle("is-bad", !fits);
    $("#w-go").disabled = !n || !fits;
  }

  async function doWrite() {
    const c = st.cards.find((x) => x.id === st.open); if (!c) return;
    const note = $("#w-note"); const tell = (m, bad) => { note.hidden = !m; note.textContent = m || ""; note.classList.toggle("is-bad", !!bad); };
    const btn = $("#w-go"); btn.disabled = true;
    try {
      const data = enc($("#w-text").value), off = Number($("#w-off").value || 0);
      tell("signing the write…");
      const h = await send(MEM(), S.write + word(c.id) + word(off) + word(0x60) + strArg(data), "write");
      tell(`written — tx ${h.slice(0, 14)}…`);
      await loadCards(); await openCard(c.id);
    } catch (e) { tell(explain(e) === "rpc error" ? short(e) : explain(e), true); btn.disabled = false; }
  }
  async function doClear() {
    const c = st.cards.find((x) => x.id === st.open); if (!c) return;
    if (!confirm(`Wipe every byte on card #${c.id}?`)) return;
    const note = $("#w-note"); const tell = (m, bad) => { note.hidden = !m; note.textContent = m || ""; note.classList.toggle("is-bad", !!bad); };
    try { tell("signing…"); await send(MEM(), S.clear + word(c.id), "clear"); tell("cleared"); await loadCards(); await openCard(c.id); }
    catch (e) { tell(explain(e) === "rpc error" ? short(e) : explain(e), true); }
  }
  async function doSeal() {
    const c = st.cards.find((x) => x.id === st.open); if (!c) return;
    if (!confirm(`Seal card #${c.id} forever? Nobody — you included — will ever write on it again.`)) return;
    const note = $("#w-note"); const tell = (m, bad) => { note.hidden = !m; note.textContent = m || ""; note.classList.toggle("is-bad", !!bad); };
    try { tell("signing…"); await send(MEM(), S.seal + word(c.id), "seal"); tell("sealed"); await loadCards(); await openCard(c.id); }
    catch (e) { tell(explain(e) === "rpc error" ? short(e) : explain(e), true); }
  }
  async function doSetContent() {
    const c = st.cards.find((x) => x.id === st.open); if (!c) return;
    const note = $("#p-note"); const tell = (m, bad) => { note.hidden = !m; note.textContent = m || ""; note.classList.toggle("is-bad", !!bad); };
    try {
      const uri = $("#p-uri").value.trim();
      if (!/^(ipfs:\/\/|https:\/\/)/.test(uri)) throw new Error("the content is an ipfs:// or https:// address");
      // l'hash del contenuto: qui l'hash dell'indirizzo (chi vuole quello del file lo mette dall'agente)
      const hashHex = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc(uri))));
      tell("signing…");
      const u = enc(uri);
      await send(MEM(), S.setContent + word(c.id) + hashHex + word(0x60) + strArg(u), "setContent");
      tell("content set"); await openCard(c.id);
    } catch (e) { tell(explain(e) === "rpc error" ? short(e) : explain(e), true); }
  }
  async function doSetName() {
    const c = st.cards.find((x) => x.id === st.open); if (!c) return;
    const note = $("#p-note"); const tell = (m, bad) => { note.hidden = !m; note.textContent = m || ""; note.classList.toggle("is-bad", !!bad); };
    try {
      const name = $("#p-name").value.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) throw new Error(ERRORS["0x153736cd"]);
      tell("signing…");
      await send(MEM(), S.setName + word(c.id) + word(0x40) + strArg(enc(name)), "setName");
      tell(`named: ${name}`); await openCard(c.id);
    } catch (e) { tell(explain(e) === "rpc error" ? short(e) : explain(e), true); }
  }

  // ---- avvio -----------------------------------------------------------------------
  async function main() {
    if (!gate()) return;
    $("#k-buy").addEventListener("click", buy);
    $("#gal").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) openCard(Number(b.dataset.id)); });
    $("#v-tab-text").addEventListener("click", () => { st.hex = false; $("#v-tab-text").classList.add("is-on"); $("#v-tab-hex").classList.remove("is-on"); const c = st.cards.find((x) => x.id === st.open); if (c) drawDump(c, kindOf(c)); });
    $("#v-tab-hex").addEventListener("click", () => { st.hex = true; $("#v-tab-hex").classList.add("is-on"); $("#v-tab-text").classList.remove("is-on"); const c = st.cards.find((x) => x.id === st.open); if (c) drawDump(c, kindOf(c)); });
    $("#w-text").addEventListener("input", sizeNote); $("#w-off").addEventListener("input", sizeNote);
    $("#w-go").addEventListener("click", doWrite); $("#w-clear").addEventListener("click", doClear); $("#w-seal").addEventListener("click", doSeal);
    $("#p-set").addEventListener("click", doSetContent); $("#p-name-set").addEventListener("click", doSetName);
    try { await loadKinds(); } catch (e) { $("#k-list").innerHTML = `<span class="field-note is-bad">${esc(short(e))}</span>`; }
    try { await loadCards(); } catch (e) { $("#gal").innerHTML = `<div class="gal-empty">${esc(short(e))}</div>`; }
    if (window.RH4_WALLET) window.RH4_WALLET.onChange(() => { drawCards(); if (st.open) openCard(st.open); });
    const want = Number(Q.get("id") || 0);
    if (want) openCard(want);
  }
  document.addEventListener("DOMContentLoaded", main);
})();
