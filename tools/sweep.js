#!/usr/bin/env node
/**
 * sweep.js — riscuote le fee di tutte le posizioni nei vault.
 *
 *   PRIVATE_KEY=0x... node tools/sweep.js [--interval MS] [--min 0.001] [--dry-run]
 *
 *     --interval MS   ripeti ogni MS millisecondi (senza: un giro solo)
 *     --min X         riscuoti solo se la simulazione promette almeno X di
 *                     una delle due monete (in unita' intere; default 0.001)
 *     --rpc URL       default: mainnet Robinhood Chain
 *     --dry-run       guarda e racconta, non manda niente
 *
 * Ogni collect() sui vault buyback fa tutto da solo: matura la quota del
 * coniatore, allunga la riserva del chip e compra RH4 per la madre. Questo
 * keeper e' solo il dito che preme il bottone a intervalli, per tutti.
 * Anche i vault della prima generazione vengono spazzati.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createPublicClient, createWalletClient, http, parseAbi, formatEther, decodeFunctionResult, encodeFunctionData } = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const NPM_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96, address, address, address token0, address token1, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)",
]);
const VAULT_ABI = parseAbi(["function collect(uint256 tokenId) returns (uint256 amount0, uint256 amount1)"]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** docs/config.js e' un global del browser: lo si legge in una sandbox. */
function siteConfig() {
  const src = fs.readFileSync(path.join(__dirname, "..", "docs", "config.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.RH4_CONFIG;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run"]);
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  const dryRun = Boolean(args["dry-run"]);
  const interval = args.interval ? Number(args.interval) : 0;
  const min = BigInt(Math.round(Number(args.min || "0.001") * 1e6)) * 10n ** 12n;

  const cfg = siteConfig();
  const NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
  const vaults = [cfg.creatorVault, cfg.feeVault, ...(cfg.legacyVaults || [])].filter(Boolean);

  const chain = chainFor(rpc);
  const account = accountFromEnv();
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const symbols = new Map();
  const sym = async (t) => {
    if (!symbols.has(t)) symbols.set(t, await pub.readContract({ address: t, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"));
    return symbols.get(t);
  };

  console.log(`RH-4 sweeper — ${vaults.length} vault, soglia ${formatEther(min)}, ${dryRun ? "DRY RUN" : "live"} — keeper ${account.address}`);

  do {
    let swept = 0, skipped = 0;
    for (const vault of vaults) {
      const n = Number(await pub.readContract({ address: NPM, abi: NPM_ABI, functionName: "balanceOf", args: [vault] }));
      for (let i = 0; i < n; i++) {
        const tokenId = await pub.readContract({ address: NPM, abi: NPM_ABI, functionName: "tokenOfOwnerByIndex", args: [vault, BigInt(i)] });
        const pos = await pub.readContract({ address: NPM, abi: NPM_ABI, functionName: "positions", args: [tokenId] });
        const [t0, t1] = [pos[2], pos[3]];
        // la simulazione dice quanto uscirebbe, senza spendere
        let a0 = 0n, a1 = 0n;
        try {
          const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "collect", args: [tokenId] });
          const r = await pub.call({ account: account.address, to: vault, data });
          [a0, a1] = decodeFunctionResult({ abi: VAULT_ABI, functionName: "collect", data: r.data });
        } catch (e) {
          console.log(`  ${vault.slice(0, 8)} #${tokenId}: simulazione fallita — ${(e.shortMessage || e.message).split("\n")[0].slice(0, 80)}`);
          continue;
        }
        if (a0 < min && a1 < min) { skipped++; continue; }
        const line = `${formatEther(a0)} ${await sym(t0)} + ${formatEther(a1)} ${await sym(t1)}`;
        if (dryRun) { console.log(`  [dry] ${vault.slice(0, 8)} #${tokenId}: riscuoterei ${line}`); swept++; continue; }
        try {
          const hash = await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "collect", args: [tokenId] });
          const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
          console.log(`  ${vault.slice(0, 8)} #${tokenId}: ${line} — ${rc.status === "success" ? "riscosso" : "FALLITO"} ${hash.slice(0, 12)}…`);
          if (rc.status === "success") swept++;
        } catch (e) {
          console.log(`  ${vault.slice(0, 8)} #${tokenId}: invio fallito — ${(e.shortMessage || e.message).split("\n")[0].slice(0, 80)}`);
        }
      }
    }
    console.log(`  giro finito: ${swept} riscosse, ${skipped} sotto soglia — ${new Date().toISOString()}`);
    if (interval) await sleep(interval);
  } while (interval);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
