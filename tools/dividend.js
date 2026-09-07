#!/usr/bin/env node
/**
 * dividend.js — il keeper del RH4StockVault: alloca, converte, ricompra, pubblica.
 *
 *   PRIVATE_KEY=0x... node tools/dividend.js <comando> [opzioni]
 *
 *   status                       cosa c'e' nel vault: secchi, azioni, epoche
 *   allocate                     divide l'ETH arrivato (marketing / buyback / holder)
 *   convert [--max-eth 0.5]      ETH degli holder -> azioni, secondo i pesi in config
 *   buyback [--max-eth 0.05]     ETH del secchio buyback -> RH4 in fabbrica, a fette
 *   publish --file epoch-N.json [--days 60]
 *                                apre l'epoca N con TUTTE le azioni non distribuite
 *   expire --epoch N             chiude un'epoca scaduta, il resto torna nel mucchio
 *   push --epoch N [--limit K] [--include-contracts]
 *                                fa il claim PER CONTO di ogni holder dell'epoca
 *                                (le azioni vanno a lui): nessuno deve connettere
 *                                un wallet. Salta chi ha gia' ritirato e i pool
 *                                Uniswap (le azioni ci morirebbero). Gli account con
 *                                delega EIP-7702 (0xef0100..., i wallet delle app) e
 *                                gli smart wallet ricevono normalmente; con
 *                                --skip-contracts si salta ogni indirizzo con codice
 *                                che non sia una delega 7702 (restano ritirabili dal sito).
 *   round [--max-eth ...]        allocate + convert + buyback in un colpo
 *
 *     --slip BPS    tolleranza sul prezzo (default 200)
 *     --dry-run     racconta, non manda
 *
 * I pesi fra le azioni stanno in docs/config.js (stockVaultWeights, in bps);
 * senza, si divide in parti uguali fra le azioni attive nel vault.
 * Il minOut di ogni swap e' letto QUI dallo spot, prima della transazione.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createPublicClient, createWalletClient, http, parseAbi, formatEther, formatUnits, parseEther, keccak256, encodeAbiParameters } = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const V3F = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const RH4 = "0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";

const VAULT_ABI = parseAbi([
  "function unallocated() view returns (uint256)",
  "function ethForStocks() view returns (uint256)",
  "function ethForBuyback() view returns (uint256)",
  "function holdersBps() view returns (uint256)",
  "function marketingBps() view returns (uint256)",
  "function buybackBps() view returns (uint256)",
  "function executor() view returns (address)",
  "function owner() view returns (address)",
  "function stockCount() view returns (uint256)",
  "function stocks(uint256) view returns (address)",
  "function stockInfo(address) view returns (bool active, uint24 fee)",
  "function undistributed(address) view returns (uint256)",
  "function epochCount() view returns (uint256)",
  "function epoch(uint256) view returns (bytes32 root, uint256 totalEligible, uint64 publishedAt, uint64 expiresAt, address[] tokens, uint256[] amounts, uint256[] claimed, bool expired)",
  "function allocate()",
  "function convert(address stock, uint256 amountIn, uint256 minOut)",
  "function buyback(uint256 amountIn, uint256 minOut)",
  "function publish(bytes32 root, uint256 totalEligible, address[] tokens, uint256[] amounts, uint64 duration) returns (uint256)",
  "function expire(uint256 id)",
  "function claim(uint256 id, address account, uint256 balance, bytes32[] proof)",
  "function hasClaimed(uint256, address) view returns (bool)",
]);
const V3F_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const POOL_ABI = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)"]);
const PM_ABI = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

function siteConfig() {
  const src = fs.readFileSync(path.join(__dirname, "..", "docs", "config.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.RH4_CONFIG;
}
function num(v, dflt) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : dflt; }
const short = (e) => (e.shortMessage || e.message || String(e)).split("\n")[0].slice(0, 120);

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run"]);
  const cmd = process.argv.slice(2).find((a) => !a.startsWith("--")) || "status";
  const cfg = siteConfig();
  const vault = args.vault || cfg.stockVault;   // --vault 0x... per un test su fork
  if (!vault) { console.error("docs/config.js non ha stockVault (o passa --vault)"); process.exit(2); }
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  const dryRun = Boolean(args["dry-run"]);
  const slipBps = BigInt(num(args.slip, 200));
  const chain = chainFor(rpc);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const account = cmd === "status" ? null : accountFromEnv();
  const wallet = account ? createWalletClient({ account, chain, transport: http(rpc) }) : null;
  const read = (fn, a = []) => pub.readContract({ address: vault, abi: VAULT_ABI, functionName: fn, args: a });
  const symCache = new Map();
  const sym = async (t) => { if (!symCache.has(t)) symCache.set(t, await pub.readContract({ address: t, abi: ERC20_ABI, functionName: "symbol" }).catch(() => t.slice(0, 8))); return symCache.get(t); };
  const dec = async (t) => pub.readContract({ address: t, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18);

  const send = async (label, functionName, fnArgs) => {
    if (dryRun) { console.log(`  [dry] ${label}`); return true; }
    try {
      const gas = await pub.estimateContractGas({ account, address: vault, abi: VAULT_ABI, functionName, args: fnArgs });
      const hash = await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName, args: fnArgs, gas: gas * 13n / 10n });
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      console.log(`  ${label} — ${rc.status === "success" ? "ok" : "FALLITO"} ${hash.slice(0, 12)}…`);
      return rc.status === "success";
    } catch (e) { console.log(`  ${label} — fallito: ${short(e)}`); return false; }
  };

  const activeStocks = async () => {
    const n = Number(await read("stockCount"));
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = await read("stocks", [BigInt(i)]);
      const [active, fee] = await read("stockInfo", [s]);
      if (active) out.push({ address: s, fee });
    }
    return out;
  };

  // ---- status ----
  if (cmd === "status") {
    const [un, es, eb, h, m, b, ex, ow, n] = await Promise.all([read("unallocated"), read("ethForStocks"), read("ethForBuyback"), read("holdersBps"), read("marketingBps"), read("buybackBps"), read("executor"), read("owner"), read("epochCount")]);
    console.log(`RH4StockVault ${vault}`);
    console.log(`  owner ${ow}  executor ${ex}`);
    console.log(`  split holder ${Number(h) / 100}% / marketing ${Number(m) / 100}% / buyback ${Number(b) / 100}%`);
    console.log(`  ETH: da allocare ${formatEther(un)} | per azioni ${formatEther(es)} | per buyback ${formatEther(eb)}`);
    for (const s of await activeStocks()) console.log(`  ${await sym(s.address)} (fee ${s.fee}): non distribuite ${formatUnits(await read("undistributed", [s.address]), await dec(s.address))}`);
    for (let i = 0; i < Number(n); i++) {
      const e = await read("epoch", [BigInt(i)]);
      const parts = [];
      for (let k = 0; k < e[4].length; k++) parts.push(`${formatUnits(e[6][k], await dec(e[4][k]))}/${formatUnits(e[5][k], await dec(e[4][k]))} ${await sym(e[4][k])}`);
      console.log(`  epoca ${i}: ${e[7] ? "CHIUSA" : "aperta"} fino a ${new Date(Number(e[3]) * 1000).toISOString().slice(0, 10)} · ritirato ${parts.join(", ")}`);
    }
    return;
  }

  const ex = await read("executor"), ow = await read("owner");
  if (ex.toLowerCase() !== account.address.toLowerCase() && ow.toLowerCase() !== account.address.toLowerCase())
    console.log(`  attenzione: ${account.address} non e' ne' executor (${ex}) ne' owner (${ow}): le transazioni falliranno`);

  // ---- allocate ----
  async function allocate() {
    const un = await read("unallocated");
    if (un < parseEther("0.0001")) { console.log(`  allocate: niente da dividere (${formatEther(un)} ETH)`); return; }
    await send(`allocate ${formatEther(un)} ETH`, "allocate", []);
  }

  // ---- convert: ETH degli holder -> azioni, per pesi ----
  async function convert() {
    const es = await read("ethForStocks");
    const maxEth = parseEther(String(args["max-eth"] || "0.5"));
    if (es < parseEther("0.0005")) { console.log(`  convert: secchio holder quasi vuoto (${formatEther(es)} ETH)`); return; }
    const stocks = await activeStocks();
    if (!stocks.length) { console.log("  convert: nessuna azione attiva nel vault"); return; }
    const weights = cfg.stockVaultWeights || {};
    const wOf = (a) => BigInt(weights[a.toLowerCase()] ?? weights[a] ?? Math.floor(10000 / stocks.length));
    const wSum = stocks.reduce((s, x) => s + wOf(x.address), 0n);
    const budget = es < maxEth ? es : maxEth;
    for (const s of stocks) {
      const amountIn = budget * wOf(s.address) / wSum;
      if (amountIn < parseEther("0.0002")) continue;
      const pool = await pub.readContract({ address: V3F, abi: V3F_ABI, functionName: "getPool", args: [WETH, s.address, s.fee] });
      if (/^0x0+$/.test(pool)) { console.log(`  ${await sym(s.address)}: pool WETH fee ${s.fee} inesistente`); continue; }
      const [sqrtP] = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" });
      const sp = BigInt(sqrtP);
      const wethIs0 = WETH.toLowerCase() < s.address.toLowerCase();
      const out = wethIs0 ? ((amountIn * sp) >> 96n) * sp >> 96n : ((amountIn << 96n) / sp << 96n) / sp;
      const minOut = out * (10000n - slipBps) / 10000n;
      await send(`convert ${formatEther(amountIn)} ETH -> >= ${formatUnits(minOut, await dec(s.address))} ${await sym(s.address)} (fee ${s.fee})`, "convert", [s.address, amountIn, minOut]);
    }
  }

  // ---- buyback: spot v4 letto qui ----
  async function buyback() {
    let eb = await read("ethForBuyback");
    const maxEth = parseEther(String(args["max-eth"] || "0.05"));
    if (eb < parseEther("0.001")) { console.log(`  buyback: secchio quasi vuoto (${formatEther(eb)} ETH)`); return; }
    const poolId = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      ["0x0000000000000000000000000000000000000000", RH4, 0, 200, HOOK]));
    const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
    while (eb >= parseEther("0.001")) {
      const amountIn = eb < maxEth ? eb : maxEth;
      const raw = await pub.readContract({ address: POOL_MANAGER, abi: PM_ABI, functionName: "extsload", args: [slot] });
      const sqrtP = BigInt(raw) & ((1n << 160n) - 1n);
      const spotOut = ((amountIn * sqrtP) >> 96n) * sqrtP >> 96n;   // ETH e' currency0
      const minOut = spotOut * (10000n - slipBps) / 10000n;
      const ok = await send(`buyback ${formatEther(amountIn)} ETH -> >= ${formatEther(minOut)} RH4`, "buyback", [amountIn, minOut]);
      if (!ok || dryRun) break;
      eb = await read("ethForBuyback");
    }
  }

  // ---- publish ----
  async function publish() {
    const file = args.file;
    if (!file) { console.error("publish vuole --file docs/dividends/epoch-N.json"); process.exit(2); }
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    const n = Number(await read("epochCount"));
    if (snap.epoch !== n) { console.error(`il file e' l'epoca ${snap.epoch}, il vault aspetta la ${n}`); process.exit(1); }
    const stocks = await activeStocks();
    const tokens = [], amounts = [];
    for (const s of stocks) {
      const u = await read("undistributed", [s.address]);
      if (u > 0n) { tokens.push(s.address); amounts.push(u); }
    }
    if (!tokens.length) { console.log("  publish: nessuna azione da distribuire"); return; }
    const days = BigInt(num(args.days, 60));
    const parts = []; for (let i = 0; i < tokens.length; i++) parts.push(`${formatUnits(amounts[i], await dec(tokens[i]))} ${await sym(tokens[i])}`);
    await send(`publish epoca ${n}: ${parts.join(" + ")} a ${snap.holders} holder (${formatEther(BigInt(snap.totalEligible))} RH4), ${days} giorni`,
      "publish", [snap.root, BigInt(snap.totalEligible), tokens, amounts, days * 86400n]);
  }

  // ---- push: il claim fatto dal keeper per ogni holder ----
  async function push() {
    if (args.epoch === undefined) { console.error("push vuole --epoch N"); process.exit(2); }
    const id = BigInt(args.epoch);
    const dir = args.dir || path.join(__dirname, "..", "docs", "dividends");
    const snap = JSON.parse(fs.readFileSync(path.join(dir, `epoch-${args.epoch}.json`), "utf8"));
    const e = await read("epoch", [id]);
    if (e[7]) { console.log("  epoca chiusa, niente da spingere"); return; }
    const entries = Object.entries(snap.claims);
    const limit = args.limit ? Number(args.limit) : Infinity;
    const skipContracts = Boolean(args["skip-contracts"]);
    const POOL_TOKEN0 = "0x0dfe1681";
    // che cos'e' un indirizzo con codice: delega 7702 (un EOA a tutti gli effetti),
    // pool Uniswap (risponde a token0), o un contratto qualunque (smart wallet...)
    const kindOf = async (addr) => {
      const code = await pub.getCode({ address: addr }).catch(() => null);
      if (code === null) return "unknown";
      if (!code || code === "0x") return "eoa";
      if (/^0xef0100[0-9a-f]{40}$/i.test(code)) return "eoa7702";
      const t0 = await pub.call({ to: addr, data: POOL_TOKEN0 }).catch(() => null);
      if (t0 && t0.data && t0.data.length === 66) return "pool";
      return "contract";
    };
    // chi ha gia' ritirato (a fette, in batch)
    const done = new Map();
    for (let i = 0; i < entries.length; i += 40) {
      const slice = entries.slice(i, i + 40);
      const res = await Promise.all(slice.map(([a]) => read("hasClaimed", [id, a]).catch(() => null)));
      slice.forEach(([a], k) => done.set(a, res[k]));
    }
    let sent = 0, ok = 0, skippedDone = 0, skippedCode = 0, skippedPool = 0, failed = 0;
    let nonce = await pub.getTransactionCount({ address: account.address });
    for (const [addr, entry] of entries) {
      if (sent >= limit) break;
      if (done.get(addr) === true) { skippedDone++; continue; }
      if (done.get(addr) === null) { failed++; continue; }
      const kind = await kindOf(addr);
      if (kind === "unknown") { failed++; continue; }
      if (kind === "pool") { skippedPool++; continue; }
      if (kind === "contract" && skipContracts) { skippedCode++; continue; }
      const fnArgs = [id, addr, BigInt(entry.balance), entry.proof];
      if (dryRun) { console.log(`  [dry] claim epoca ${id} per ${addr} [${kind}] (${formatEther(BigInt(entry.balance))} RH4)`); sent++; continue; }
      try {
        const hash = await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "claim", args: fnArgs, nonce });
        nonce++; sent++;
        const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
        if (rc.status === "success") ok++; else failed++;
        process.stdout.write(`\r  spediti ${sent} · riusciti ${ok} · falliti ${failed} · gia' ritirati ${skippedDone} · pool saltati ${skippedPool} · contratti saltati ${skippedCode}   `);
      } catch (err) {
        failed++;
        console.log(`\n  ${addr}: ${short(err)}`);
        nonce = await pub.getTransactionCount({ address: account.address });
      }
    }
    console.log(`\n  push epoca ${id}: spediti ${sent}, riusciti ${ok}, falliti ${failed}, gia' ritirati ${skippedDone}, pool saltati ${skippedPool}, contratti saltati ${skippedCode}`);
  }

  async function expire() {
    if (args.epoch === undefined) { console.error("expire vuole --epoch N"); process.exit(2); }
    await send(`expire epoca ${args.epoch}`, "expire", [BigInt(args.epoch)]);
  }

  if (cmd === "allocate") await allocate();
  else if (cmd === "convert") await convert();
  else if (cmd === "buyback") await buyback();
  else if (cmd === "publish") await publish();
  else if (cmd === "expire") await expire();
  else if (cmd === "push") await push();
  else if (cmd === "round") { await allocate(); await convert(); await buyback(); }
  else { console.error(`comando sconosciuto: ${cmd}`); process.exit(2); }
}

main().catch((e) => { console.error(e); process.exit(1); });
