/**
 * wallet.js — il wallet nell'header, su tutte le pagine.
 *
 * Un bottone CONNECT che, collegato, diventa la pill con l'indirizzo e un
 * menu': profilo, copia, scollega. La connessione si ricorda in localStorage
 * e al ritorno si riprende senza popup (eth_accounts non chiede nulla).
 * Nessuna chiave passa di qui: e' solo il wallet del browser che risponde.
 */
(function () {
  "use strict";

  const CFG = () => window.RH4_CONFIG || {};
  const KEY = "rh4_wallet";
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

  const RH4W = { address: null, listeners: [] };
  window.RH4_WALLET = RH4W;
  RH4W.onChange = (fn) => { RH4W.listeners.push(fn); if (RH4W.address) fn(RH4W.address); };
  const notify = () => RH4W.listeners.forEach((fn) => { try { fn(RH4W.address); } catch (_) {} });

  RH4W.connect = async function () {
    const provider = window.ethereum;
    if (!provider) { alert("no wallet found in this browser"); return null; }
    const [account] = await provider.request({ method: "eth_requestAccounts" });
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG().chainIdHex }] });
    } catch (e) {
      if (e && e.code === 4902) {
        await provider.request({ method: "wallet_addEthereumChain", params: [{
          chainId: CFG().chainIdHex, chainName: CFG().chainName,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [CFG().rpc], blockExplorerUrls: [CFG().explorer] }] });
      }
    }
    RH4W.address = account;
    try { localStorage.setItem(KEY, "1"); } catch (_) {}
    render();
    notify();
    return account;
  };

  RH4W.disconnect = function () {
    RH4W.address = null;
    try { localStorage.removeItem(KEY); } catch (_) {}
    render();
    notify();
  };

  async function restore() {
    let want = false;
    try { want = localStorage.getItem(KEY) === "1"; } catch (_) {}
    if (!want || !window.ethereum) return;
    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts && accounts[0]) { RH4W.address = accounts[0]; render(); notify(); }
    } catch (_) {}
  }

  let host, btn, menu;
  function build() {
    const nav = document.querySelector("header.nav");
    if (!nav) return;
    host = document.createElement("div");
    host.className = "wal";
    host.innerHTML =
      `<button class="btn btn-light btn-sm wal-btn" type="button">CONNECT</button>` +
      `<div class="wal-menu" hidden>` +
      `<a class="wal-item" href="profile.html">PROFILE</a>` +
      `<button class="wal-item" type="button" data-act="copy">COPY ADDRESS</button>` +
      `<button class="wal-item" type="button" data-act="out">DISCONNECT</button></div>`;
    // prima dei bottoni X / Source
    const first = nav.querySelector("a.btn");
    nav.insertBefore(host, first || null);
    btn = host.querySelector(".wal-btn");
    menu = host.querySelector(".wal-menu");
    btn.addEventListener("click", () => {
      if (!RH4W.address) { RH4W.connect(); return; }
      menu.hidden = !menu.hidden;
    });
    menu.querySelector('[data-act="copy"]').addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(RH4W.address); } catch (_) {}
      menu.hidden = true;
    });
    menu.querySelector('[data-act="out"]').addEventListener("click", () => { menu.hidden = true; RH4W.disconnect(); });
    document.addEventListener("click", (e) => { if (host && !host.contains(e.target)) menu.hidden = true; });
    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on("accountsChanged", (accs) => {
        RH4W.address = accs && accs[0] ? accs[0] : null;
        if (!RH4W.address) { try { localStorage.removeItem(KEY); } catch (_) {} }
        render(); notify();
      });
    }
  }

  function render() {
    if (!btn) return;
    if (RH4W.address) {
      btn.textContent = short(RH4W.address);
      btn.classList.add("is-on");
      btn.title = RH4W.address;
    } else {
      btn.textContent = "CONNECT";
      btn.classList.remove("is-on");
      btn.title = "";
      menu.hidden = true;
    }
  }

  document.addEventListener("DOMContentLoaded", () => { build(); restore(); });
})();
