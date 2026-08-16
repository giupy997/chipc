#!/usr/bin/env node
/**
 * keeper.js — tiene il clock della RH-4.
 *
 *   PRIVATE_KEY=0x... node tools/keeper.js --cpu 0x<indirizzo>
 *
 *     --cpu 0x...      indirizzo del processore (oppure RH4_ADDRESS)
 *     --rpc URL        default: mainnet Robinhood Chain
 *     --budget 0.05    tetto di spesa in ETH: raggiunto, si ferma
 *     --cycles N       ferma dopo N cicli portati a casa
 *     --interval MS    spaziatura minima fra un tick e il successivo
 *     --gas N          limite di gas per tick (default 120000)
 *     --poll MS        ogni quanto interrogare l'RPC (default 40)
 *     --dry-run        guarda e racconta, non manda niente
 *
 * `tick()` e' aperto a chiunque, quindi questo keeper non ha nessun diritto
 * speciale: e' solo il primo a pagare. Se qualcun altro tocca il clock nello
 * stesso blocco la nostra transazione fallisce, ed e' esattamente cio' che
 * deve succedere — quel ciclo l'ha sponsorizzato lui. Lo contiamo e si tira
 * avanti.
 *
 * Il tetto di spesa non e' un vezzo: a 10 Hz continui il clock brucia circa
 * 1 ETH al giorno. Un keeper senza budget lasciato acceso e' un rubinetto
 * aperto.
 */

const {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  parseEventLogs,
} = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const ABI = [
  {
    type: "function",
    name: "tick",
    inputs: [],
    outputs: [
      { name: "pc_", type: "uint8" },
      { name: "out_", type: "uint8" },
      { name: "halted_", type: "bool" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "inspect",
    inputs: [],
    outputs: [
      { name: "pc", type: "uint8" },
      { name: "out", type: "uint8" },
      { name: "halted", type: "bool" },
      { name: "cycles", type: "uint256" },
      { name: "lastTickBlock", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Cycle",
    inputs: [
      { name: "cycle", type: "uint256", indexed: true },
      { name: "sponsor", type: "address", indexed: true },
      { name: "pc", type: "uint8" },
      { name: "instr", type: "uint16" },
      { name: "out", type: "uint8" },
      { name: "halted", type: "bool" },
    ],
  },
  { type: "error", name: "OneTickPerBlock", inputs: [] },
  { type: "error", name: "AlreadyHalted", inputs: [] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run"]);
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  const cpu = args.cpu || process.env.RH4_ADDRESS;
  const dryRun = Boolean(args["dry-run"]);

  if (!cpu) {
    console.error("manca --cpu 0x<indirizzo> (oppure RH4_ADDRESS)");
    process.exit(2);
  }

  const budget = args.budget ? parseEther(String(args.budget)) : null;
  const maxCycles = args.cycles ? Number(args.cycles) : Infinity;
  const interval = args.interval ? Number(args.interval) : 0;
  const gasLimit = BigInt(args.gas || 120000);

  // viem interroga la ricevuta ogni 4 secondi di suo: su una chain da 100 ms
  // vorrebbe dire quaranta blocchi persi a ogni tick. Qui si va molto piu'
  // fitto, perche' il collo di bottiglia del clock e' proprio questa attesa.
  const pollingInterval = Number(args.poll || 40);

  const chain = chainFor(rpc);
  const account = accountFromEnv();
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval });
  const wallet = createWalletClient({ account, chain, transport: http(rpc), pollingInterval });

  const balance = await pub.getBalance({ address: account.address });
  const start = await pub.readContract({ address: cpu, abi: ABI, functionName: "inspect" });

  console.log("RH-4 keeper");
  console.log(`  rete        ${chain.name} (${chain.id}) via ${rpc}`);
  console.log(`  processore  ${cpu}`);
  console.log(`  sponsor     ${account.address}  (${formatEther(balance)} ETH)`);
  console.log(`  stato       ciclo ${start[3]}, pc=${start[0]}, out=${start[1]}${start[2] ? ", FERMO" : ""}`);
  console.log(
    `  limiti      ${budget ? formatEther(budget) + " ETH" : "nessun budget"}` +
      `, ${maxCycles === Infinity ? "cicli illimitati" : maxCycles + " cicli"}` +
      `${interval ? `, min ${interval} ms fra i tick` : ""}` +
      `${dryRun ? ", DRY RUN" : ""}`
  );
  console.log();

  if (start[2]) {
    console.error("il processore ha incontrato HLT: solo l'operatore puo' ripartire (reset()).");
    process.exit(1);
  }

  const stats = { sent: 0, landed: 0, lost: 0, spent: 0n, t0: Date.now() };
  let running = true;
  let freshReceipt = false;
  let lastTickBlock = start[4];
  let nonce = await pub.getTransactionCount({ address: account.address });

  const summary = () => {
    const secs = (Date.now() - stats.t0) / 1000;
    console.log("\n--- riepilogo ---");
    console.log(`  cicli portati a casa   ${stats.landed}`);
    console.log(`  persi (altro sponsor)  ${stats.lost}`);
    console.log(`  speso                  ${formatEther(stats.spent)} ETH`);
    if (stats.landed) {
      console.log(`  costo per ciclo        ${formatEther(stats.spent / BigInt(stats.landed))} ETH`);
      console.log(`  frequenza tenuta       ${(stats.landed / secs).toFixed(2)} Hz`);
    }
  };

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      running = false;
      console.log(`\n${sig}: mi fermo dopo il tick in corso.`);
    });
  }

  while (running && stats.landed < maxCycles) {
    if (budget && stats.spent >= budget) {
      console.log("budget esaurito.");
      break;
    }

    // Un ciclo per blocco. Se veniamo da una ricevuta non serve chiedere il
    // numero di blocco: quella transazione e' gia' in un blocco chiuso, e la
    // prossima non puo' che finire in uno successivo. Un giro di RPC in meno
    // per ciclo, ed e' quello che separa i 5 Hz dal ritmo della chain.
    if (freshReceipt) {
      freshReceipt = false;
    } else {
      const bn = await pub.getBlockNumber();
      if (bn <= lastTickBlock) {
        await sleep(25);
        continue;
      }
    }

    if (dryRun) {
      console.log(`[dry] manderei tick() al blocco ${bn}`);
      lastTickBlock = bn;
      stats.landed++;
      await sleep(Math.max(interval, 100));
      continue;
    }

    let hash;
    try {
      // Gas fissato apposta: senza stima si risparmia un giro di RPC, e una
      // stima fallirebbe comunque se qualcuno ci ha battuto sul blocco.
      hash = await wallet.writeContract({
        address: cpu,
        abi: ABI,
        functionName: "tick",
        gas: gasLimit,
        nonce,
      });
      stats.sent++;
      nonce++;
    } catch (err) {
      // nonce fuori sincrono, RPC che sbuffa: si risincronizza e si riprova
      console.log(`  invio fallito: ${short(err)}`);
      nonce = await pub.getTransactionCount({ address: account.address });
      await sleep(250);
      continue;
    }

    const receipt = await pub.waitForTransactionReceipt({
      hash,
      pollingInterval,
      timeout: 30_000,
    });
    stats.spent += receipt.gasUsed * receipt.effectiveGasPrice;
    lastTickBlock = receipt.blockNumber;
    freshReceipt = true;

    if (receipt.status !== "success") {
      // Quasi sempre OneTickPerBlock: un altro sponsor ha pagato quel ciclo.
      stats.lost++;
      console.log(`  blocco ${receipt.blockNumber}: ciclo andato a qualcun altro`);
      continue;
    }

    stats.landed++;

    // Lo stato nuovo e' gia' dentro la ricevuta: leggerlo dall'evento invece
    // di richiamare inspect() risparmia un altro giro di RPC per ciclo.
    const [event] = parseEventLogs({ abi: ABI, eventName: "Cycle", logs: receipt.logs });
    const { pc, out, halted } = event.args;

    const secs = (Date.now() - stats.t0) / 1000;
    process.stdout.write(
      `\r  ciclo ${String(stats.landed).padStart(6)}` +
        `  pc=${String(pc).padStart(3)}  out=${String(out).padStart(2)}` +
        `  ${(stats.landed / secs).toFixed(2)} Hz` +
        `  ${formatEther(stats.spent)} ETH   `
    );

    if (halted) {
      console.log("\n\nil processore ha incontrato HLT. Il clock si ferma qui.");
      break;
    }

    if (interval) await sleep(interval);
  }

  summary();
}

function short(err) {
  const m = String(err.shortMessage || err.message || err);
  return m.split("\n")[0].slice(0, 120);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
