#!/usr/bin/env node
/**
 * holders.js — il keeper del ChipHoldersVault: riscuote le fee dei chip in
 * modalita' HOLDERS e le distribuisce a chi tiene il token, a epoche.
 *
 *   PRIVATE_KEY=0x... node tools/holders.js <comando> [opzioni]
 *
 *   status                        posizioni nel vault e mucchi in attesa, per chip
 *   collect [--min 0.001]         collect() su ogni posizione con fee sopra soglia
 *   snapshot --token 0x.. [--min 10000] [--block B]
 *                                 fotografa gli holder del chip token e scrive
 *                                 docs/holders/epoch-<id>.json (id = prossima epoca del vault)
 *   publish --file docs/holders/epoch-N.json [--days 60]
 *                                 apre l'epoca sul vault con tutto il mucchio del chip
 *   push --id N [--limit K]       claim() per ogni holder dell'epoca: il keeper paga il gas
 *   expire --id N                 chiude un'epoca scaduta, il resto torna nel mucchio
 *   round [--min-eth 0.002] [--days 60] [--limit K]
 *                                 per ogni chip nel vault: collect, poi se il mucchio
 *                                 vale la pena snapshot + publish + push
 *
 *     --min X       (collect) riscuoti solo se la simulazione promette almeno X
 *     --min-eth X   (round) apri un'epoca solo se il WETH degli holder e' almeno X
 *     --min N       (snapshot) saldo minimo in token per entrare nell'albero (default 10000)
 *     --dry-run     racconta, non manda
 *     --vault 0x..  --rpc URL
 *
 * Chi puo' fare cosa: collect e claim sono di tutti; publish ed expire solo
 * dell'executor, quindi la chiave qui deve essere quella nominata nel vault.
 * Il gas di publish e dei push torna al keeper dal vault (dal 20% buyback),
 * finche' il vault ha ETH: il keeper anticipa e basta.
 * La conversione del 20% buyback (convert/buyback) la fa tools/sweep.js,
 * che conosce anche questo vault.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, formatEther, formatUnits, parseEther, getAddress, encodeFunctionData, decodeFunctionResult } = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const V3F = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const FEE_TIERS = [100, 500, 3000, 10000];
/// chi tiene chip token senza essere un holder
const SYSTEM = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
  NPM,
  "0x8366a39CC670B4001A1121B8F6A443A643e40951",   // PoolManager v4
  "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",   // hook pons
  "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",   // pons locker
  "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",   // pons escrow
  "0x42df2a798f82289E177311362e8f5ccC45c1219c",   // pons buyback vault
];

const VAULT_ABI = parseAbi([
  "function collect(uint256 tokenId) returns (uint256 amount0, uint256 amount1)",
  "function undistributed(address token, address asset) view returns (uint256)",
  "function pending(address asset) view returns (uint256)",
  "function executor() view returns (address)",
  "function epochCount() view returns (uint256)",
  "function epoch(uint256 id) view returns (address token, bytes32 root, uint256 totalEligible, uint64 publishedAt, uint64 expiresAt, address[] assets, uint256[] amounts, uint256[] claimed, bool expired)",
  "function publish(address token, bytes32 root, uint256 totalEligible, address[] assets, uint256[] amounts, uint64 duration) returns (uint256)",
  "function claim(uint256 id, address account, uint256 balance, bytes32[] proof)",
  "function hasClaimed(uint256 id, address account) view returns (bool)",
  "function expire(uint256 id)",
]);
const NPM_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128, uint128)",
]);
const FACTORY_ABI = parseAbi([
  "function chipByToken(address) view returns (uint256)",
  "function chip(uint256) view returns ((uint256 machine, bytes32 label, bytes32 ticker, address minter, uint64 bornBlock, uint32 resets, address token, uint96 rewardPerCycle))",
]);
const V3F_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => (e.shortMessage || e.message || String(e)).split("\n")[0].slice(0, 90);

function siteConfig() {
  const src = fs.readFileSync(path.join(__dirname, "..", "docs", "config.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.RH4_CONFIG;
}
function num(v, dflt) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : dflt; }

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run"]);
  const cmd = process.argv.slice(2).find((a) => !a.startsWith("--")) || "status";
  const cfg = siteConfig();
  const vault = args.vault || cfg.holdersVault;
  if (!vault) { console.error("docs/config.js non ha holdersVault (o passa --vault)"); process.exit(2); }
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  const dryRun = Boolean(args["dry-run"]);
  const outDir = args.out || path.join(__dirname, "..", "docs", cfg.holdersPath || "holders");
  const chain = chainFor(rpc);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const account = cmd === "status" ? null : accountFromEnv();
  const wallet = account ? createWalletClient({ account, chain, transport: http(rpc) }) : null;
  const read = (fn, a = []) => pub.readContract({ address: vault, abi: VAULT_ABI, functionName: fn, args: a });
  const quotes = [WETH, ...(cfg.quotes || []).map((q) => q.address)];
  const symCache = new Map();
  const sym = async (t) => { if (!symCache.has(t)) symCache.set(t, await pub.readContract({ address: t, abi: ERC20_ABI, functionName: "symbol" }).catch(() => t.slice(0, 8))); return symCache.get(t); };
  const dec = async (t) => pub.readContract({ address: t, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18);
  const fmtA = async (amt, t) => `${formatUnits(amt, await dec(t))} ${await sym(t)}`;

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

  // ---- le posizioni nel vault, con il chip di ciascuna ----
  async function positions() {
    const n = Number(await pub.readContract({ address: NPM, abi: NPM_ABI, functionName: "balanceOf", args: [vault] }));
    const out = [];
    for (let i = 0; i < n; i++) {
      const tokenId = await pub.readContract({ address: NPM, abi: NPM_ABI, functionName: "tokenOfOwnerByIndex", args: [vault, BigInt(i)] });
      const pos = await pub.readContract({ address: NPM, abi: NPM_ABI, functionName: "positions", args: [tokenId] });
      let chipId = await pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: "chipByToken", args: [pos[2]] });
      let token = pos[2], quote = pos[3];
      if (chipId === 0n) { chipId = await pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: "chipByToken", args: [pos[3]] }); token = pos[3]; quote = pos[2]; }
      out.push({ tokenId, token, quote, chipId: Number(chipId) });
    }
    return out;
  }
  const chipTokens = async () => { const m = new Map(); for (const p of await positions()) if (p.chipId) m.set(p.token.toLowerCase(), p); return [...m.values()]; };
  const pile = async (token) => {
    const assets = [], amounts = [];
    for (const a of [WETH, token, ...quotes.filter((q) => q.toLowerCase() !== WETH.toLowerCase())]) {
      const u = await read("undistributed", [token, a]);
      if (u > 0n) { assets.push(a); amounts.push(u); }
    }
    return { assets, amounts };
  };

  // ---- status ----
  async function status() {
    const ex = await read("executor");
    console.log(`ChipHoldersVault ${vault}\n  executor ${ex}\n  epoche   ${await read("epochCount")}`);
    for (const p of await positions()) {
      const { assets, amounts } = await pile(p.token);
      const parts = []; for (let i = 0; i < assets.length; i++) parts.push(await fmtA(amounts[i], assets[i]));
      console.log(`  chip #${p.chipId} ${await sym(p.token)} (pos #${p.tokenId}, vs ${await sym(p.quote)}): holders' pile ${parts.join(" + ") || "empty"}`);
    }
    for (const q of quotes.filter((q) => q.toLowerCase() !== WETH.toLowerCase())) {
      const pend = await read("pending", [q]); if (pend > 0n) console.log(`  buyback pending ${await fmtA(pend, q)}`);
    }
    console.log(`  buyback ETH ${formatEther(await pub.getBalance({ address: vault }))}`);
  }

  // ---- collect ----
  async function collect() {
    const min = parseEther(String(args.min || "0.001"));
    let swept = 0;
    for (const p of await positions()) {
      try {
        const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "collect", args: [p.tokenId] });
        const r = await pub.call({ account: account.address, to: vault, data });
        const [a0, a1] = decodeFunctionResult({ abi: VAULT_ABI, functionName: "collect", data: r.data });
        if (a0 < min && a1 < min) continue;
        if (await send(`collect chip #${p.chipId} pos #${p.tokenId}: ${formatEther(a0)} + ${formatEther(a1)}`, "collect", [p.tokenId])) swept++;
      } catch (e) { console.log(`  pos #${p.tokenId}: ${short(e)}`); }
    }
    console.log(`  collect: ${swept} posizioni riscosse`);
  }

  // ---- snapshot: gli holder di un chip token ----
  async function snapshot(tokenArg) {
    const token = getAddress(tokenArg || args.token || "");
    const chipId = Number(await pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: "chipByToken", args: [token] }));
    if (!chipId) { console.error(`${token} non e' un chip token`); process.exit(1); }
    const chip = await pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: "chip", args: [BigInt(chipId)] });
    const id = args.id !== undefined ? Number(args.id) : Number(await read("epochCount"));
    const latest = await pub.getBlockNumber();
    const block = args.block ? BigInt(args.block) : latest;
    const minBal = parseEther(String(args.min || "10000"));
    // i pool del token: chiunque li tiene non e' un holder
    const pools = [];
    for (const q of quotes) for (const fee of FEE_TIERS) {
      const [a, b] = token.toLowerCase() < q.toLowerCase() ? [token, q] : [q, token];
      const p = await pub.readContract({ address: V3F, abi: V3F_ABI, functionName: "getPool", args: [a, b, fee] }).catch(() => null);
      if (p && !/^0x0{40}$/.test(p)) pools.push(p);
    }
    const exclude = new Set([
      ...SYSTEM, cfg.factory, cfg.feeVault, cfg.creatorVault, cfg.holdersVault, cfg.stockVault, ...(cfg.legacyVaults || []),
      cfg.curve && cfg.curve.address, cfg.curve && cfg.curve.vault, token, ...pools,
      ...String(args.exclude || "").split(",").filter(Boolean),
    ].filter(Boolean).map((a) => a.toLowerCase()));

    const ev = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
    const bal = new Map();
    const STEP = 100_000n;
    let seen = 0;
    for (let from = BigInt(chip.bornBlock); from <= block; from += STEP) {
      const to = from + STEP - 1n > block ? block : from + STEP - 1n;
      let logs;
      for (let k = 0; ; k++) {
        try { logs = await pub.getLogs({ address: token, event: ev, fromBlock: from, toBlock: to }); break; }
        catch (e) { if (k >= 6) throw e; await sleep(4000 * (k + 1)); }
      }
      for (const l of logs) {
        const f = l.args.from.toLowerCase(), t = l.args.to.toLowerCase(), v = l.args.value;
        if (f !== "0x0000000000000000000000000000000000000000") bal.set(f, (bal.get(f) || 0n) - v);
        bal.set(t, (bal.get(t) || 0n) + v);
      }
      seen += logs.length;
      process.stdout.write(`\r  chip #${chipId}: blocchi ${from}..${to}, ${seen} transfer   `);
      await sleep(300);
    }
    console.log();
    const rows = [];
    let excluded = 0n, dust = 0n;
    for (const [a, v] of bal) {
      if (v <= 0n) continue;
      if (exclude.has(a)) { excluded += v; continue; }
      if (v < minBal) { dust += v; continue; }
      rows.push([id, getAddress(a), v]);
    }
    if (!rows.length) { console.log("  nessun holder sopra la soglia"); return null; }
    rows.sort((x, y) => (y[2] > x[2] ? 1 : y[2] < x[2] ? -1 : 0));
    const total = rows.reduce((s, r) => s + r[2], 0n);
    const tree = StandardMerkleTree.of(rows, ["uint256", "address", "uint256"]);
    const claims = {};
    for (const [i, v] of tree.entries()) claims[v[1]] = { balance: v[2].toString(), proof: tree.getProof(i) };
    const symbol = await sym(token);
    const out = { id, token, symbol, chip: chipId, block: block.toString(), root: tree.root, totalEligible: total.toString(),
      holders: rows.length, minBalance: minBal.toString(), excluded: [...exclude], generatedAt: new Date().toISOString(), claims };
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `epoch-${id}.json`);
    fs.writeFileSync(file, JSON.stringify(out));
    const idxFile = path.join(outDir, "index.json");
    const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, "utf8")) : { epochs: [] };
    idx.epochs = idx.epochs.filter((e) => e.id !== id).concat([{ id, token, symbol, chip: chipId, block: block.toString(), holders: rows.length, totalEligible: total.toString() }]).sort((a, b) => a.id - b.id);
    fs.writeFileSync(idxFile, JSON.stringify(idx, null, 1));
    console.log(`  epoca ${id} per chip #${chipId} ${symbol} @ blocco ${block}: ${rows.length} holder, ${formatEther(total)} eleggibili, esclusi ${formatEther(excluded)}, polvere ${formatEther(dust)}\n  radice ${tree.root}\n  scritto ${file}`);
    return file;
  }

  // ---- publish ----
  async function publish(fileArg) {
    const file = fileArg || args.file;
    if (!file) { console.error("publish vuole --file docs/holders/epoch-N.json"); process.exit(2); }
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    const n = Number(await read("epochCount"));
    if (snap.id !== n) { console.error(`il file e' l'epoca ${snap.id}, il vault aspetta la ${n}`); process.exit(1); }
    const { assets, amounts } = await pile(snap.token);
    if (!assets.length) { console.log("  publish: mucchio vuoto per questo chip"); return false; }
    const days = BigInt(num(args.days, 60));
    const parts = []; for (let i = 0; i < assets.length; i++) parts.push(await fmtA(amounts[i], assets[i]));
    return send(`publish epoca ${n} chip #${snap.chip} ${snap.symbol}: ${parts.join(" + ")} a ${snap.holders} holder, ${days} giorni`,
      "publish", [snap.token, snap.root, BigInt(snap.totalEligible), assets, amounts, days * 86400n]);
  }

  // ---- push ----
  async function push(idArg) {
    const idN = idArg !== undefined ? idArg : args.id;
    if (idN === undefined) { console.error("push vuole --id N"); process.exit(2); }
    const id = BigInt(idN);
    const snap = JSON.parse(fs.readFileSync(path.join(outDir, `epoch-${idN}.json`), "utf8"));
    const e = await read("epoch", [id]);
    if (e[8]) { console.log("  epoca chiusa, niente da spingere"); return; }
    const entries = Object.entries(snap.claims);
    const limit = args.limit ? Number(args.limit) : Infinity;
    const POOL_TOKEN0 = "0x0dfe1681";
    const kindOf = async (addr) => {
      const code = await pub.getCode({ address: addr }).catch(() => null);
      if (code === null) return "unknown";
      if (!code || code === "0x") return "eoa";
      if (/^0xef0100[0-9a-f]{40}$/i.test(code)) return "eoa7702";
      const t0 = await pub.call({ to: addr, data: POOL_TOKEN0 }).catch(() => null);
      if (t0 && t0.data && t0.data.length === 66) return "pool";
      return "contract";
    };
    const done = new Map();
    for (let i = 0; i < entries.length; i += 40) {
      const slice = entries.slice(i, i + 40);
      const res = await Promise.all(slice.map(([a]) => read("hasClaimed", [id, a]).catch(() => null)));
      slice.forEach(([a], k) => done.set(a, res[k]));
    }
    let sent = 0, ok = 0, failed = 0, skippedDone = 0, skippedPool = 0;
    console.log(`  epoca ${id} chip #${snap.chip} ${snap.symbol}: ${entries.length} holder, ${[...done.values()].filter(Boolean).length} gia' pagati`);
    let nonce = await pub.getTransactionCount({ address: account.address });
    for (const [addr, entry] of entries) {
      if (sent >= limit) break;
      if (done.get(addr) === true) { skippedDone++; continue; }
      if (done.get(addr) === null) { failed++; continue; }
      const kind = await kindOf(addr);
      if (kind === "unknown") { failed++; continue; }
      if (kind === "pool") { skippedPool++; continue; }
      const fnArgs = [id, addr, BigInt(entry.balance), entry.proof];
      if (dryRun) { console.log(`  [dry] claim epoca ${id} per ${addr} [${kind}]`); sent++; continue; }
      try {
        const hash = await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "claim", args: fnArgs, nonce });
        nonce++; sent++;
        const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
        if (rc.status === "success") ok++; else failed++;
        if (sent % 25 === 0) console.log(`  ${sent} spediti · ${ok} riusciti · ${failed} falliti`);
      } catch (err) {
        failed++;
        console.log(`\n  ${addr}: ${short(err)}`);
        nonce = await pub.getTransactionCount({ address: account.address });
      }
    }
    console.log(`\n  push epoca ${id}: spediti ${sent}, riusciti ${ok}, falliti ${failed}, gia' pagati ${skippedDone}, pool saltati ${skippedPool}`);
    if (!dryRun) console.log(`  keeper ${formatEther(await pub.getBalance({ address: account.address }))} ETH · vault ${formatEther(await pub.getBalance({ address: vault }))} ETH (il gas dei push torna qui dentro dal vault)`);
  }

  async function expire() {
    if (args.id === undefined) { console.error("expire vuole --id N"); process.exit(2); }
    await send(`expire epoca ${args.id}`, "expire", [BigInt(args.id)]);
  }

  // ---- round: tutto in fila, per ogni chip nel vault ----
  async function round() {
    await collect();
    const minEth = parseEther(String(args["min-eth"] || "0.002"));
    for (const p of await chipTokens()) {
      const w = await read("undistributed", [p.token, WETH]);
      const { assets, amounts } = await pile(p.token);
      const worth = w >= minEth || amounts.some((a, i) => assets[i].toLowerCase() !== WETH.toLowerCase() && assets[i].toLowerCase() !== p.token.toLowerCase() && a > 0n);
      if (!worth) { console.log(`  chip #${p.chipId}: mucchio sotto soglia (${formatEther(w)} WETH), si aspetta`); continue; }
      if (dryRun) { console.log(`  [dry] chip #${p.chipId}: snapshot + publish + push`); continue; }
      const file = await snapshot(p.token);
      if (!file) continue;
      const id = JSON.parse(fs.readFileSync(file, "utf8")).id;
      if (await publish(file)) await push(id);
    }
  }

  if (cmd === "status") await status();
  else if (cmd === "collect") await collect();
  else if (cmd === "snapshot") await snapshot();
  else if (cmd === "publish") await publish();
  else if (cmd === "push") await push();
  else if (cmd === "expire") await expire();
  else if (cmd === "round") await round();
  else { console.error(`comando sconosciuto: ${cmd}`); process.exit(2); }
}

main().catch((e) => { console.error(e); process.exit(1); });
