#!/usr/bin/env node
/**
 * guard.js — la guardia contro i token agganciati a mano.
 *
 *   PRIVATE_KEY=0x... node tools/guard.js [--interval MS] [--dry-run] [--rpc URL]
 *
 * La fabbrica lascia agganciare a un chip senza token un ERC20 qualsiasi
 * (attachToken), purche' ne abbia in pancia almeno un wei. Cosi' il 7 set
 * 2026 il chip 28 si e' preso NVDA: i vault, che mandano alla fabbrica tutto
 * cio' che lei riconosce come chip token, avrebbero nutrito la sua ricompensa.
 *
 * La contromossa e' nella fabbrica stessa: un tick con saldo zero del token
 * azzera la ricompensa del chip per sempre. Questa guardia scorre i chip,
 * riconosce i token NON nati dalla fabbrica (un ChipToken vero risponde a
 * factory() con l'indirizzo della fabbrica e a chipId() con il suo id) e, se
 * la ricompensa e' ancora viva, fa tick: con saldo zero la spegne; con saldo
 * positivo incassa il saldo (finisce al keeper, da girare al buyback) e
 * riprova al blocco dopo, finche' non e' spenta.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createPublicClient, createWalletClient, http, parseAbi, formatUnits } = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs, chipRanges } = require("./chain");

const FACTORY_ABI = parseAbi([
  "function totalChips() view returns (uint256)",
  "function chip(uint256) view returns ((uint256 machine, bytes32 label, bytes32 ticker, address minter, uint64 bornBlock, uint32 resets, address token, uint96 rewardPerCycle))",
  "function motherToken() view returns (address)",
  "function tick(uint256 id, uint8 inPort) returns (uint16, uint8, bool)",
]);
const TOKEN_ABI = parseAbi([
  "function factory() view returns (address)",
  "function chipId() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => (e.shortMessage || e.message || String(e)).split("\n")[0].slice(0, 90);

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
  const cfg = siteConfig();
  const chain = chainFor(rpc);
  const account = dryRun && !process.env.PRIVATE_KEY ? { address: "0x0000000000000000000000000000000000000001" } : accountFromEnv();   // in dry run si puo' solo guardare
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = dryRun ? null : createWalletClient({ account, chain, transport: http(rpc) });
  let factory = cfg.factory;   // la fabbrica del giro corrente (guard() scorre tutte)
  const readF = (fn, a = []) => pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: fn, args: a });

  // un ChipToken vero: factory() == fabbrica e chipId() == id
  async function isChipToken(token, id) {
    try {
      const f = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "factory" });
      if (f.toLowerCase() !== factory.toLowerCase()) return false;
      const c = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "chipId" });
      return c === BigInt(id);
    } catch (_) { return false; }
  }

  async function round() {
    for (const range of chipRanges(cfg)) { factory = range.factory; await roundOn(range); }
  }
  async function roundOn(range) {
    const total = range.to ?? Number(await readF("totalChips"));
    const mother = (await readF("motherToken").catch(() => "0x")).toLowerCase();
    let foreign = 0, live = 0;
    for (let id = range.from; id <= total; id++) {
      const c = await readF("chip", [BigInt(id)]);
      const token = c.token;
      if (!token || /^0x0{40}$/.test(token)) continue;
      // la madre (RH4, chip #1) e' agganciata a mano dall'owner: legittima
      if (id === 1 || token.toLowerCase() === mother || token.toLowerCase() === String(cfg.token || "").toLowerCase()) continue;
      if (await isChipToken(token, id)) continue;
      // sulle fabbriche v9 un token estraneo puo' esserci solo se l'owner l'ha ammesso (allowAttach), e un tick
      // a riserva zero non spegne piu' niente: si segnala e non si tocca
      const allowed = await pub.readContract({ address: factory, abi: parseAbi(["function attachAllowed(address) view returns (bool)"]), functionName: "attachAllowed", args: [token] }).catch(() => null);
      if (allowed !== null) { console.log(`  chip #${id}: token agganciato ${allowed ? "con permesso dell'owner" : "SENZA permesso (impossibile sulla v9: controlla)"}`); if (!allowed) foreign++; continue; }
      // i chip-guardia del team ("quote lock", un HLT): la quota e' agganciata apposta, e sono gia' fermi
      if (c.label === "0x71756f7465206c6f636b00000000000000000000000000000000000000000000") { console.log(`  chip #${id}: lucchetto del team, ok`); continue; }
      foreign++;
      const sym = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "symbol" }).catch(() => token.slice(0, 8));
      const dec = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "decimals" }).catch(() => 18);
      const bal = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [factory] });
      if (c.rewardPerCycle === 0n) { console.log(`  chip #${id}: token estraneo ${sym}, ricompensa gia' azzerata (in fabbrica ${formatUnits(bal, dec)} ${sym}, fermi)`); continue; }
      live++;
      console.log(`  chip #${id}: token estraneo ${sym}, ricompensa VIVA (${c.rewardPerCycle}/ciclo), in fabbrica ${formatUnits(bal, dec)} ${sym}`);
      // tick finche' non si spegne: con saldo zero si azzera, con saldo positivo si incassa e si riprova
      for (let k = 0; k < 6; k++) {
        if (dryRun) { console.log(`  [dry] tick(${id})`); break; }
        try {
          // prima la simulazione: un chip gia' fermo (AlreadyHalted) non si tocca, e non si paga gas per niente
          try { await pub.simulateContract({ account, address: factory, abi: FACTORY_ABI, functionName: "tick", args: [BigInt(id), 0] }); }
          catch (e) { console.log(`    tick non passerebbe (${short(e)}): fermo qui`); break; }
          const hash = await wallet.writeContract({ address: factory, abi: FACTORY_ABI, functionName: "tick", args: [BigInt(id), 0], gas: 500_000n });
          const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
          const after = await readF("chip", [BigInt(id)]);
          console.log(`    tick ${hash.slice(0, 12)}… ${rc.status === "success" ? "ok" : "FALLITO"} — ricompensa ora ${after.rewardPerCycle}`);
          if (after.rewardPerCycle === 0n) break;
          await sleep(3000);   // il blocco dopo
        } catch (e) { console.log(`    tick fallito: ${short(e)}`); await sleep(3000); }
      }
    }
    console.log(`  guardia su ${factory.slice(0, 8)}: chip ${range.from}..${total}, ${foreign} con token estraneo, ${live} da spegnere${dryRun ? " (dry run)" : ""}`);
  }

  do {
    console.log(`[${new Date().toISOString()}] guardia sulle fabbriche`);
    try { await round(); } catch (e) { console.log(`  giro fallito: ${short(e)}`); }
    if (interval) await sleep(interval);
  } while (interval);
}

main().catch((e) => { console.error(e); process.exit(1); });
