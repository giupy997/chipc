#!/usr/bin/env node
/**
 * snapshot.js — la fotografia degli holder di RH4, e l'albero che la prova.
 *
 *   node tools/snapshot.js --epoch N [--block B] [--min 1000] [--out docs/dividends]
 *
 *     --epoch N     numero dell'epoca (deve coincidere con quello del vault)
 *     --block B     blocco dello snapshot (default: l'ultimo)
 *     --min X       saldo minimo in RH4 per entrare nell'albero (default 1000)
 *     --exclude a,b altri indirizzi da escludere, oltre a quelli di sistema
 *     --out DIR     dove scrivere epoch-N.json (default docs/dividends)
 *     --rpc URL
 *
 * Ricostruisce i saldi dai Transfer del token, tenendo una cache incrementale
 * in tools/state/rh4-holders.json cosi' i giri successivi leggono solo i
 * blocchi nuovi. Esclude i contratti di sistema (fabbrica, vault, locker di
 * pons, PoolManager...) che tengono RH4 ma non sono "holder".
 *
 * L'albero e' lo StandardMerkleTree di OpenZeppelin con foglie
 * (uint256 epoch, address account, uint256 balance): e' esattamente
 * quello che RH4StockVault.leaf() ricostruisce on-chain.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { createPublicClient, http, parseAbiItem, formatEther, parseEther, getAddress } = require("viem");
const { DEFAULT_RPC, chainFor, parseArgs } = require("./chain");

const RH4 = "0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B";
const FROM_BLOCK = 51_000_000n;   // prima della nascita di questa generazione del token
const STATE = path.join(__dirname, "state", "rh4-holders.json");

/// chi tiene RH4 senza essere un holder: contratti di sistema, pool, locker
const SYSTEM = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
  "0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b",   // ChipFactory8: la riserva di mining
  "0x8366a39CC670B4001A1121B8F6A443A643e40951",   // Uniswap v4 PoolManager (tutti i pool v4)
  "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",   // V2MemeHook di pons
  "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",   // pons Launch Locker
  "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",   // pons Fee Escrow
  "0x42df2a798f82289E177311362e8f5ccC45c1219c",   // pons Buyback Vault
  "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",   // NPM v3
];

function siteConfig() {
  const src = fs.readFileSync(path.join(__dirname, "..", "docs", "config.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.RH4_CONFIG;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), []);
  if (args.epoch === undefined) { console.error("serve --epoch N"); process.exit(2); }
  const epoch = Number(args.epoch);
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  const minBal = parseEther(String(args.min || "1000"));
  const outDir = args.out || path.join(__dirname, "..", "docs", "dividends");
  const cfg = siteConfig();
  const exclude = new Set([
    ...SYSTEM, cfg.feeVault, cfg.creatorVault, cfg.holdersVault, ...(cfg.creatorVaultsLegacy || []), ...(cfg.feeVaultsLegacy || []), ...(cfg.legacyVaults || []), cfg.stockVault, cfg.curve && cfg.curve.address, cfg.curve && cfg.curve.vault,
    ...String(args.exclude || "").split(",").filter(Boolean),
  ].filter(Boolean).map((a) => a.toLowerCase()));

  const pub = createPublicClient({ chain: chainFor(rpc), transport: http(rpc) });
  const latest = await pub.getBlockNumber();
  const block = args.block ? BigInt(args.block) : latest;

  // ---- saldi dai Transfer, con cache incrementale ----
  let state = { block: FROM_BLOCK - 1n, balances: {} };
  if (fs.existsSync(STATE)) {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (BigInt(s.block) <= block) state = { block: BigInt(s.block), balances: s.balances };
  }
  const bal = new Map(Object.entries(state.balances).map(([a, v]) => [a, BigInt(v)]));
  const ev = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  const STEP = 100_000n;
  let logsSeen = 0;
  for (let from = state.block + 1n; from <= block; from += STEP) {
    const to = from + STEP - 1n > block ? block : from + STEP - 1n;
    let logs;
    for (let k = 0; ; k++) {
      try { logs = await pub.getLogs({ address: RH4, event: ev, fromBlock: from, toBlock: to }); break; }
      catch (e) { if (k >= 6) throw e; await new Promise((r) => setTimeout(r, 4000 * (k + 1))); }
    }
    for (const l of logs) {
      const f = l.args.from.toLowerCase(), t = l.args.to.toLowerCase(), v = l.args.value;
      if (f !== "0x0000000000000000000000000000000000000000") bal.set(f, (bal.get(f) || 0n) - v);
      bal.set(t, (bal.get(t) || 0n) + v);
    }
    logsSeen += logs.length;
    process.stdout.write(`\r  blocchi ${from}..${to}: ${logsSeen} transfer letti   `);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log();
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ block: block.toString(), balances: Object.fromEntries([...bal].map(([a, v]) => [a, v.toString()])) }));

  // ---- le foglie ----
  const rows = [];
  let excludedBal = 0n, dustBal = 0n, negative = 0;
  for (const [a, v] of bal) {
    if (v < 0n) { negative++; continue; }
    if (v === 0n) continue;
    if (exclude.has(a)) { excludedBal += v; continue; }
    if (v < minBal) { dustBal += v; continue; }
    rows.push([epoch, getAddress(a), v]);
  }
  if (negative) console.log(`  attenzione: ${negative} saldi negativi (log mancanti?), ignorati`);
  rows.sort((x, y) => (y[2] > x[2] ? 1 : y[2] < x[2] ? -1 : 0));
  const total = rows.reduce((s, r) => s + r[2], 0n);
  if (!rows.length) { console.error("nessun holder sopra la soglia"); process.exit(1); }

  const tree = StandardMerkleTree.of(rows, ["uint256", "address", "uint256"]);
  const claims = {};
  for (const [i, v] of tree.entries()) claims[v[1]] = { balance: v[2].toString(), proof: tree.getProof(i) };

  const out = {
    epoch, block: block.toString(), root: tree.root, totalEligible: total.toString(),
    holders: rows.length, minBalance: minBal.toString(), token: RH4,
    excluded: [...exclude], generatedAt: new Date().toISOString(),
    claims,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `epoch-${epoch}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  // l'indice che il sito legge per sapere quali epoche esistono
  const idxFile = path.join(outDir, "index.json");
  const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, "utf8")) : { epochs: [] };
  idx.epochs = idx.epochs.filter((e) => e.epoch !== epoch).concat([{ epoch, block: block.toString(), root: tree.root, holders: rows.length, totalEligible: total.toString() }]).sort((a, b) => a.epoch - b.epoch);
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 1));

  console.log(`epoca ${epoch} @ blocco ${block}`);
  console.log(`  holder nell'albero   ${rows.length}  (>= ${formatEther(minBal)} RH4)`);
  console.log(`  RH4 eleggibile       ${formatEther(total)}`);
  console.log(`  esclusi (sistema)    ${formatEther(excludedBal)} RH4 su ${exclude.size} indirizzi`);
  console.log(`  polvere sotto soglia ${formatEther(dustBal)} RH4`);
  console.log(`  radice               ${tree.root}`);
  console.log(`  scritto              ${file}`);
  console.log(`\npublish sul vault: root=${tree.root} totalEligible=${total.toString()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
