#!/usr/bin/env node
/**
 * sweep.js — il keeper dei vault buyback: riscuote, converte, ricompra.
 *
 *   PRIVATE_KEY=0x... node tools/sweep.js [--interval MS] [--min 0.001] [--dry-run]
 *
 *     --interval MS   ripeti ogni MS millisecondi (senza: un giro solo)
 *     --min X         riscuoti solo se la simulazione promette almeno X di
 *                     una delle due monete (unita' intere, default 0.001)
 *     --max-eth X     tetto per singolo buyback (default 0.05): oltre, a fette
 *     --slip BPS      tolleranza sul prezzo per convert/buyback (default 200)
 *     --rpc URL       default: mainnet Robinhood Chain
 *     --dry-run       guarda e racconta, non manda niente
 *
 * Tre passi, in quest'ordine, per ogni giro:
 *   1. collect() su ogni posizione nei vault con fee sopra soglia (di tutti,
 *      non swappa: accredita il coniatore, riserva, parcheggia la quote)
 *   2. convert() delle quote in attesa (NVDA...) in ETH, col minimo letto
 *      QUI dallo spot — prima della transazione, non dentro
 *   3. buyback() dell'ETH in RH4 per la fabbrica, a fette, col minimo letto
 *      dal PoolManager v4 qui fuori
 * Solo l'executor puo' fare 2 e 3: la chiave di questo keeper deve essere
 * quella nominata nel vault (setExecutor dall'owner della fabbrica).
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createPublicClient, createWalletClient, http, parseAbi, formatEther, decodeFunctionResult, encodeFunctionData, keccak256, encodeAbiParameters, encodePacked } = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const V3F = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const RH4 = "0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const QUOTES = [NVDA]; // le quote non-WETH che i vault possono parcheggiare

const NPM_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96, address, address, address token0, address token1, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)",
]);
const VAULT_ABI = parseAbi([
  "function collect(uint256 tokenId) returns (uint256 amount0, uint256 amount1)",
  "function pending(address token) view returns (uint256)",
  "function executor() view returns (address)",
  "function convert(address token, uint256 amountIn, uint256 minOut, uint24 fee)",
  "function buyback(uint256 amountIn, uint256 minOut)",
]);
const V3F_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const POOL_ABI = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)"]);
const PM_ABI = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function balanceOf(address) view returns (uint256)"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => (e.shortMessage || e.message || String(e)).split("\n")[0].slice(0, 90);

/** docs/config.js e' un global del browser: lo si legge in una sandbox. */
function siteConfig() {
  const src = fs.readFileSync(path.join(__dirname, "..", "docs", "config.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.RH4_CONFIG;
}

function num(v, dflt) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : dflt; }

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run"]);
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  const dryRun = Boolean(args["dry-run"]);
  const interval = num(args.interval, 0);
  const min = BigInt(Math.round(num(args.min, 0.001) * 1e6)) * 10n ** 12n;
  const maxEth = BigInt(Math.round(num(args["max-eth"], 0.05) * 1e6)) * 10n ** 12n;
  const slipBps = BigInt(Math.round(num(args.slip, 200)));

  const cfg = siteConfig();
  const buybackVaults = [cfg.creatorVault, cfg.feeVault].filter(Boolean);
  const legacyVaults = cfg.legacyVaults || [];

  const chain = chainFor(rpc);
  const account = accountFromEnv();
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const symbols = new Map();
  const sym = async (t) => {
    if (!symbols.has(t)) symbols.set(t, await pub.readContract({ address: t, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"));
    return symbols.get(t);
  };

  console.log(`RH-4 sweeper — ${buybackVaults.length} vault buyback + ${legacyVaults.length} legacy, soglia ${formatEther(min)}, tolleranza ${slipBps} bps, ${dryRun ? "DRY RUN" : "live"} — keeper ${account.address}`);
  for (const v of buybackVaults) {
    const ex = await pub.readContract({ address: v, abi: VAULT_ABI, functionName: "executor" }).catch(() => null);
    if (ex && ex.toLowerCase() !== account.address.toLowerCase()) console.log(`  attenzione: l'executor di ${v.slice(0, 8)} e' ${ex}, non questo keeper — convert/buyback falliranno`);
  }

  const send = async (label, address, functionName, fnArgs) => {
    if (dryRun) { console.log(`  [dry] ${label}`); return true; }
    try {
      const gas = await pub.estimateContractGas({ account, address, abi: VAULT_ABI, functionName, args: fnArgs });
      const hash = await wallet.writeContract({ address, abi: VAULT_ABI, functionName, args: fnArgs, gas: gas * 13n / 10n });
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      console.log(`  ${label} — ${rc.status === "success" ? "ok" : "FALLITO"} ${hash.slice(0, 12)}…`);
      return rc.status === "success";
    } catch (e) { console.log(`  ${label} — invio fallito: ${short(e)}`); return false; }
  };

  // ---- 1. riscuotere ----
  async function sweepAll() {
    let swept = 0, skipped = 0;
    for (const vault of [...buybackVaults, ...legacyVaults]) {
      const n = Number(await pub.readContract({ address: NPM, abi: NPM_ABI, functionName: "balanceOf", args: [vault] }));
      for (let i = 0; i < n; i++) {
        try {
          const tokenId = await pub.readContract({ address: NPM, abi: NPM_ABI, functionName: "tokenOfOwnerByIndex", args: [vault, BigInt(i)] });
          const pos = await pub.readContract({ address: NPM, abi: NPM_ABI, functionName: "positions", args: [tokenId] });
          const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "collect", args: [tokenId] });
          const r = await pub.call({ account: account.address, to: vault, data });
          const [a0, a1] = decodeFunctionResult({ abi: VAULT_ABI, functionName: "collect", data: r.data });
          if (a0 < min && a1 < min) { skipped++; continue; }
          const line = `collect ${vault.slice(0, 8)} #${tokenId}: ${formatEther(a0)} ${await sym(pos[2])} + ${formatEther(a1)} ${await sym(pos[3])}`;
          if (await send(line, vault, "collect", [tokenId])) swept++;
        } catch (e) { console.log(`  ${vault.slice(0, 8)} posizione ${i}: ${short(e)}`); }
      }
    }
    return { swept, skipped };
  }

  // ---- 2. convertire le quote in attesa: minimo dallo spot v3, letto qui ----
  async function convertPending(vault) {
    for (const token of QUOTES) {
      const pend = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "pending", args: [token] });
      if (pend < min) continue;
      let best = null;
      for (const fee of [500, 3000, 10000]) {
        const pool = await pub.readContract({ address: V3F, abi: V3F_ABI, functionName: "getPool", args: [token, WETH, fee] });
        if (pool === "0x0000000000000000000000000000000000000000") continue;
        const depth = await pub.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [pool] });
        if (!best || depth > best.depth) best = { pool, fee, depth };
      }
      if (!best) { console.log(`  ${await sym(token)}: nessun pool con WETH, aspetta`); continue; }
      const [sqrtP] = await pub.readContract({ address: best.pool, abi: POOL_ABI, functionName: "slot0" });
      const tokenIs0 = token.toLowerCase() < WETH.toLowerCase();
      const sp = BigInt(sqrtP);
      const wethOut = tokenIs0
        ? ((pend * sp) >> 96n) * sp >> 96n
        : ((pend << 96n) / sp << 96n) / sp;
      const minOut = wethOut * (10000n - slipBps) / 10000n;
      await send(`convert ${vault.slice(0, 8)}: ${formatEther(pend)} ${await sym(token)} -> >= ${formatEther(minOut)} ETH (fee ${best.fee})`,
        vault, "convert", [token, pend, minOut, best.fee]);
    }
  }

  // ---- 3. ricomprare: minimo dallo spot v4 (extsload), letto qui ----
  async function buybackAll(vault) {
    let bal = await pub.getBalance({ address: vault });
    if (bal < min) return;
    const key = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      ["0x0000000000000000000000000000000000000000", RH4, 0, 200, HOOK]);
    const slot = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(key), 6n]));
    while (bal >= min) {
      const amountIn = bal > maxEth ? maxEth : bal;
      const raw = BigInt(await pub.readContract({ address: POOL_MANAGER, abi: PM_ABI, functionName: "extsload", args: [slot] }));
      const sqrtP = raw & ((1n << 160n) - 1n);
      const spotOut = ((amountIn * sqrtP) >> 96n) * sqrtP >> 96n;
      const minOut = spotOut * (10000n - slipBps) / 10000n;
      const ok = await send(`buyback ${vault.slice(0, 8)}: ${formatEther(amountIn)} ETH -> >= ${formatEther(minOut)} RH4`, vault, "buyback", [amountIn, minOut]);
      if (!ok || dryRun) break;
      bal = await pub.getBalance({ address: vault });
    }
  }

  do {
    try {
      const { swept, skipped } = await sweepAll();
      for (const v of buybackVaults) { await convertPending(v); await buybackAll(v); }
      console.log(`  giro finito: ${swept} riscosse, ${skipped} sotto soglia — ${new Date().toISOString()}`);
    } catch (e) {
      console.log(`  giro interrotto: ${short(e)} — riprovo al prossimo`);
    }
    if (interval) await sleep(interval);
  } while (interval);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
