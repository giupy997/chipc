/**
 * agents.js — la vetrina degli agenti.
 *
 * Un agente qui e' un wallet che ha coniato un chip e lo ha firmato: il link
 * "sito" del chip, scrivibile solo dal minter, punta al plugin ElizaOS. La
 * pagina scorre le due fabbriche, legge i link nei due ChipSocials, tiene i
 * chip firmati e li raggruppa per minter. Poi, per ogni agente, cerca le sue
 * memory card negli eventi del contratto. Tutto in eth_call e eth_getLogs sul
 * nodo pubblico: niente database, niente iscrizioni, niente da moderare.
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const CFG = () => window.RH4_CONFIG || {};
  const RPC = () => CFG().rpc;
  const AGENT_MARK = "https://github.com/giupy997/chipc/tree/main/eliza/plugin-rh4";

  const S = {
    totalChips: "0x73514205", chip: "0x8c6aefcf", inspect: "0xb3e98ae8", logo: "0xa29ba8a7",
    links: "0x881d8a40", balanceOf: "0x70a08231", ownerOf: "0x6352211e",
    card: "0xbfcfd9b9", kinds: "0x1be40a49", read: "0xdcd1749b",
  };
  const TOPIC_CARD_MINTED = "0x9a2e01237a6ee1a2453316ccf4a37ef98d8cb4584ae257c512469369995f63f7";

  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const addrWord = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  const w = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
  const wordAt = (hex, i) => BigInt("0x" + w(hex, i));
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const bytesFromHex = (h) => { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return b; };
  const utf8 = (h) => new TextDecoder("utf-8", { fatal: false }).decode(bytesFromHex(h));
  const b32ToString = (hex) => { let out = ""; for (let i = 0; i < 64; i += 2) { const c = parseInt(hex.slice(i, i + 2), 16); if (!c) break; out += String.fromCharCode(c); } return out; };
  /** una stringa dinamica il cui offset sta nella parola `i` */
  const strAt = (hex, i) => { const off = Number(wordAt(hex, i)) / 32; const len = Number(wordAt(hex, off)); return len ? utf8(hex.slice(2 + (off + 1) * 64, 2 + (off + 1) * 64 + len * 2)) : ""; };
  const fmtNum = (n) => Number(n).toLocaleString("en-US");
  const fmtEth = (wei) => { const n = Number(wei) / 1e18; return n >= 1 ? n.toFixed(3) : n.toFixed(4); };
  const fmtRh4 = (wei) => { const n = Number(wei) / 1e18; return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : Math.round(n); };
  const ipfs = (u) => u.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/");

  async function rpc(method, params, tries = 3) {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(RPC(), { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return data.result;
      } catch (e) { if (i >= tries - 1) throw e; await sleep(500 * (i + 1)); }
    }
  }
  async function rpcBatch(reqs) {
    const out = new Array(reqs.length);
    for (let start = 0; start < reqs.length; start += 40) {
      const slice = reqs.slice(start, start + 40);
      const res = await fetch(RPC(), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(slice.map((r, i) => ({ jsonrpc: "2.0", id: start + i, ...r }))) });
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [data];
      const byId = new Map(arr.map((r) => [r.id, r]));
      for (let i = 0; i < slice.length; i++) { const r = byId.get(start + i); out[start + i] = r && !r.error ? r.result : null; }
    }
    return out;
  }
  const ecall = (to, data) => ({ method: "eth_call", params: [{ to, data }, "latest"] });
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

  /** dove vive ogni chip: la fabbrica di prima fino a legacy.lastId, poi quella viva */
  async function chipRanges() {
    const c = CFG(), L = c.legacy || {};
    const total = Number(wordAt(await call(c.factory, S.totalChips), 0));
    const out = [];
    if (L.factory && L.lastId) out.push({ factory: L.factory, socials: L.socials, from: 1, to: Number(L.lastId) });
    out.push({ factory: c.factory, socials: c.socials, from: (Number(L.lastId) || 0) + 1, to: total });
    return out;
  }

  /** i chip firmati da un agente, con stato e logo */
  async function agentChips() {
    const ranges = await chipRanges();
    const all = [];
    for (const r of ranges) for (let id = r.from; id <= r.to; id++) all.push({ id, ...r });
    const hidden = new Set((CFG().hiddenChips || []).map(Number));
    const live = all.filter((c) => !hidden.has(c.id));
    // 1. i link di ogni chip, dal registro della sua fabbrica
    const links = await rpcBatch(live.map((c) => ecall(c.socials, S.links + word(c.id))));
    const signed = live.filter((c, i) => { try { return strAt(links[i], 1) === AGENT_MARK; } catch (_) { return false; } });
    if (!signed.length) return [];
    // 2. chip, stato e logo solo per quelli firmati
    const nowBlock = BigInt(await rpc("eth_blockNumber", []));
    const res = await rpcBatch(signed.flatMap((c) => [
      ecall(c.factory, S.chip + word(c.id)), ecall(c.factory, S.inspect + word(c.id)), ecall(c.factory, S.logo + word(c.id)),
    ]));
    return signed.map((c, k) => {
      const chipHex = res[k * 3], insHex = res[k * 3 + 1], logoHex = res[k * 3 + 2];
      if (!chipHex || !insHex) return null;
      return {
        id: c.id,
        label: b32ToString(w(chipHex, 1)), ticker: b32ToString(w(chipHex, 2)),
        minter: "0x" + w(chipHex, 3).slice(24), token: "0x" + w(chipHex, 6).slice(24),
        halted: wordAt(insHex, 2) === 1n, cycles: Number(wordAt(insHex, 3)),
        behind: Number(nowBlock - wordAt(insHex, 4)),
        logo: logoHex ? (() => { try { return strAt(logoHex, 0); } catch (_) { return ""; } })() : "",
      };
    }).filter(Boolean);
  }

  /** le memory card che un wallet possiede adesso (dagli eventi, poi ownerOf) */
  async function cardsOf(owner) {
    const mem = CFG().memory;
    if (!mem) return [];
    let logs = [];
    try {
      logs = await rpc("eth_getLogs", [{ address: mem, fromBlock: "0x" + Number(CFG().memoryBlock || 0).toString(16), toBlock: "latest",
        topics: [TOPIC_CARD_MINTED, null, "0x" + addrWord(owner)] }]);
    } catch (_) { return []; }
    const ids = [...new Set(logs.map((l) => Number(BigInt(l.topics[1]))))];
    if (!ids.length) return [];
    const [owners, cards] = await Promise.all([
      rpcBatch(ids.map((id) => ecall(mem, S.ownerOf + word(id)))),
      rpcBatch(ids.map((id) => ecall(mem, S.card + word(id)))),
    ]);
    const mine = [];
    ids.forEach((id, i) => {
      if (!owners[i] || !cards[i]) return;
      if (("0x" + w(owners[i], 0).slice(24)).toLowerCase() !== owner.toLowerCase()) return;   // venduta o regalata
      mine.push({ id, kind: Number(wordAt(cards[i], 0)), locked: wordAt(cards[i], 1) === 1n,
        used: Number(wordAt(cards[i], 2)), writes: Number(wordAt(cards[i], 4)),
        label: b32ToString(w(cards[i], 5)) });
    });
    // il taglio e le prime righe scritte
    const kinds = await rpcBatch(mine.map((c) => ecall(mem, S.kinds + word(c.kind))));
    const peeks = await rpcBatch(mine.map((c) => c.used ? ecall(mem, S.read + word(c.id) + word(0) + word(Math.min(160, c.used))) : null).filter(Boolean));
    let p = 0;
    mine.forEach((c, i) => {
      if (kinds[i]) { c.kindName = strAt(kinds[i], 4); c.capacity = Number(wordAt(kinds[i], 0)); c.onchain = wordAt(kinds[i], 1) === 1n; }
      if (c.used) { const r = peeks[p++]; try { c.peek = r ? utf8(bytesFromHex(strAtRaw(r))) : ""; } catch (_) { c.peek = ""; } }
    });
    return mine;
  }
  /** i byte grezzi di un bytes dinamico (senza passare per utf8 due volte) */
  function strAtRaw(hex) { const off = Number(wordAt(hex, 0)) / 32; const len = Number(wordAt(hex, off)); return hex.slice(2 + (off + 1) * 64, 2 + (off + 1) * 64 + len * 2); }

  // ---- disegno ---------------------------------------------------------------
  function chipEl(c) {
    const stalled = !c.halted && c.behind > 36000;
    const st = c.halted ? ["HALTED", "halt"] : stalled ? ["IDLE", "stall"] : ["RUNNING", "run"];
    const logo = c.logo
      ? `<img src="${esc(ipfs(c.logo))}" alt="" loading="lazy" referrerpolicy="no-referrer"
           onerror="if(!this.dataset.r){this.dataset.r=1;this.src=this.src.replace('ipfs.io/ipfs','gateway.pinata.cloud/ipfs')}else{this.hidden=true}">`
      : `<img alt="" hidden>`;
    return `<a class="achip" href="chip.html?id=${c.id}">${logo}<div class="t">` +
      `<div class="tick">$${esc(c.ticker)}</div><div class="nm">#${c.id} ${esc(c.label)}</div>` +
      `<div class="st ${st[1]}">${st[0]} · ${fmtNum(c.cycles)} cycles</div></div></a>`;
  }
  function cardEl(c) {
    const pct = c.capacity ? Math.min(100, (c.used / c.capacity) * 100) : 0;
    return `<a class="acard" href="memory.html?id=${c.id}">` +
      `<div class="r1"><span>CARD #${c.id}</span><span>${esc(c.kindName || "?")}${c.locked ? " ·SEALED" : ""}</span></div>` +
      (c.peek ? `<div class="note">${esc(c.peek.slice(0, 140))}</div>` : `<div class="note">blank</div>`) +
      `<div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>` +
      `<div class="note" style="max-height:none">${fmtNum(c.used)} bytes · ${c.writes} write${c.writes === 1 ? "" : "s"}</div></a>`;
  }

  async function main() {
    const host = $("#roster");
    let chips = [];
    try { chips = await agentChips(); }
    catch (e) { host.innerHTML = `<div class="empty">could not read the chain: ${esc(String(e.message || e))}</div>`; return; }

    if (!chips.length) {
      $("#roster-count").textContent = "EMPTY";
      host.innerHTML = `<div class="empty">No signed chip yet. The first agent to mint one lands here by itself.</div>`;
      ["n-agents", "n-chips", "n-cards", "n-cycles"].forEach((k) => ($("#" + k).textContent = "0"));
      return;
    }

    // raggruppati per wallet: un agente puo' avere piu' di un chip
    const byAgent = new Map();
    for (const c of chips) {
      const k = c.minter.toLowerCase();
      if (!byAgent.has(k)) byAgent.set(k, { address: c.minter, chips: [] });
      byAgent.get(k).chips.push(c);
    }
    const agents = [...byAgent.values()];
    $("#n-agents").textContent = agents.length;
    $("#n-chips").textContent = chips.length;
    $("#n-cycles").textContent = fmtNum(chips.reduce((a, c) => a + c.cycles, 0));
    $("#roster-count").textContent = `${agents.length} AGENT${agents.length === 1 ? "" : "S"}`;

    // saldi e card, un agente alla volta: la lista appare subito e si arricchisce
    let totalCards = 0;
    host.innerHTML = agents.map((a) =>
      `<div class="agent" id="a-${a.address.toLowerCase()}">` +
      `<div class="agent-head"><span class="who"><a href="${CFG().explorer}/address/${a.address}" target="_blank" rel="noopener">${short(a.address)}</a></span>` +
      `<span class="bal" data-bal>reading balances…</span><span class="sig">SIGNED ON-CHAIN</span></div>` +
      `<div class="agent-body"><p class="agent-sub">ITS MACHINES</p><div class="chips-row">${a.chips.map(chipEl).join("")}</div></div>` +
      `<div class="agent-body" data-cards hidden></div></div>`).join("");

    for (const a of agents) {
      const box = document.getElementById("a-" + a.address.toLowerCase());
      try {
        const [ethHex, rh4Hex] = await Promise.all([
          rpc("eth_getBalance", [a.address, "latest"]),
          CFG().token ? call(CFG().token, S.balanceOf + addrWord(a.address)) : Promise.resolve(null),
        ]);
        box.querySelector("[data-bal]").innerHTML =
          `<b>${fmtEth(BigInt(ethHex))}</b> ETH` + (rh4Hex ? ` &nbsp;·&nbsp; <b>${fmtRh4(wordAt(rh4Hex, 0))}</b> RH4` : "");
      } catch (_) { box.querySelector("[data-bal]").textContent = ""; }
      try {
        const cards = await cardsOf(a.address);
        if (cards.length) {
          totalCards += cards.length;
          const sec = box.querySelector("[data-cards]");
          sec.hidden = false;
          sec.innerHTML = `<p class="agent-sub">ITS MEMORY</p><div class="cards-row">${cards.map(cardEl).join("")}</div>`;
          $("#n-cards").textContent = totalCards;
        }
      } catch (_) {}
    }
    if ($("#n-cards").textContent === "…") $("#n-cards").textContent = String(totalCards);
  }

  document.addEventListener("DOMContentLoaded", main);
})();
