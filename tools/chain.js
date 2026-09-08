/**
 * chain.js — roba comune a deploy.js e keeper.js.
 *
 * La chiave privata si legge SOLO da PRIVATE_KEY nell'ambiente. Non passa
 * mai da riga di comando: finirebbe nella cronologia della shell.
 */

const { defineChain } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

function chainFor(rpcUrl) {
  if (!rpcUrl || rpcUrl === DEFAULT_RPC) return robinhoodChain;
  return { ...robinhoodChain, rpcUrls: { default: { http: [rpcUrl] } } };
}

function accountFromEnv() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error(
      "manca PRIVATE_KEY nell'ambiente.\n" +
        "  export PRIVATE_KEY=0x...   (e non scriverla mai in chat)"
    );
    process.exit(2);
  }
  return privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
}

/** Parser minimale di argomenti: --chiave valore, piu' flag booleane. */
function parseArgs(argv, flags = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    out[key] = flags.includes(key) ? true : argv[++i];
  }
  return out;
}

/** docs/config.js e' un global del browser: lo si legge in una sandbox. */
function siteConfig() {
  const fs = require("fs"), path = require("path"), vm = require("vm");
  const src = fs.readFileSync(path.join(__dirname, "..", "docs", "config.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.RH4_CONFIG;
}
/** La fabbrica di un chip: quella di prima fino a legacy.lastId, poi quella viva. */
function factoryFor(cfg, id) {
  const L = cfg.legacy || {};
  return L.factory && Number(id) <= Number(L.lastId || 0) ? L.factory : cfg.factory;
}
/** Le fabbriche con il loro intervallo di id: [{factory, from, to|null}]. */
function chipRanges(cfg) {
  const L = cfg.legacy || {};
  const out = [];
  if (L.factory && Number(L.lastId) > 0 && L.factory.toLowerCase() !== String(cfg.factory).toLowerCase()) out.push({ factory: L.factory, from: 1, to: Number(L.lastId) });
  out.push({ factory: cfg.factory, from: out.length ? Number(L.lastId) + 1 : 1, to: null });
  return out;
}
/** Tutte le fabbriche, senza doppioni. */
function factoriesOf(cfg) { return [...new Set(chipRanges(cfg).map((r) => r.factory.toLowerCase()))]; }

module.exports = { DEFAULT_RPC, robinhoodChain, chainFor, accountFromEnv, parseArgs, siteConfig, factoryFor, chipRanges, factoriesOf };
