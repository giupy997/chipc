#!/usr/bin/env node
/**
 * deploy-factory.js — mette in piedi la fabbrica di chip.
 *
 *   PRIVATE_KEY=0x... node tools/deploy-factory.js
 *
 *     --rpc URL        default: mainnet Robinhood Chain
 *     --gates 0x...    riusa un RH4GateArray gia' deployato invece di
 *                      pagarne un altro (il silicio e' uno per chain)
 *     --renderer 0x... riusa un ChipRenderer gia' deployato. Anche lui e'
 *                      `pure` e non sa niente di quale fabbrica lo chiama.
 *     --mint FILE      conia subito il primo chip con questo programma
 *     --label NOME     nome esteso del primo chip, max 32 caratteri
 *     --ticker SIGLA   sigla del primo chip: 1-8 fra A-Z, 0-9 e trattino,
 *                      unica in tutta la fabbrica
 *     --liquidity BPS  quota dell'offerta che va subito a chi conia, in
 *                      centesimi di punto (2000 = 20%). Max 5000.
 *     --target N       su quanti cicli spalmare la riserva. A 10 Hz:
 *                      25.920.000 = 30 giorni, 315.360.000 = un anno.
 *     --owner 0x...    chi comanda la fabbrica (default: chi deploya).
 *                      Utile per deployare da un wallet caldo e lasciare i
 *                      poteri a uno freddo o a un multisig.
 *     --dry-run        calcola i costi e non manda niente
 *
 * Tre contratti, in quest'ordine:
 *
 *   1. RH4GateArray   il silicio. 1.029 NAND srotolati, ~16,7 kB. Si paga
 *                     UNA volta per tutta la chain: e' `pure`, non ha stato
 *                     e non ha padrone. Se ne esiste gia' uno, passalo con
 *                     --gates e questo passo si salta.
 *   2. ChipRenderer   disegna l'SVG degli NFT leggendo i 79 bit veri.
 *   3. ChipFactory    l'ERC-721. Ogni chip e' un processore vero.
 */

const fs = require("fs");
const {
  getAddress,
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  encodeDeployData,
  stringToHex,
} = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const ART = (name) => `out/${name}.sol/${name}.json`;

function artifact(name) {
  const p = ART(name);
  if (!fs.existsSync(p)) {
    console.error(`manca ${p} — compila prima con "make gates && forge build"`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run"]);
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  const dryRun = Boolean(args["dry-run"]);

  const chain = chainFor(rpc);
  const account = accountFromEnv();
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  const gasPrice = await pub.getGasPrice();
  const balance = await pub.getBalance({ address: account.address });

  console.log("deploy della fabbrica di chip RH-4");
  console.log(`  rete        ${chain.name} (${chain.id}) via ${rpc}`);
  console.log(`  operatore   ${account.address}  (${formatEther(balance)} ETH)`);
  console.log(`  gas price   ${Number(gasPrice) / 1e9} gwei`);
  console.log();

  const spent = { total: 0n };

  async function deploy(name, argsList, label) {
    const art = artifact(name);
    const data = encodeDeployData({
      abi: art.abi,
      bytecode: art.bytecode.object,
      args: argsList,
    });
    const gas = await pub.estimateGas({ account, data });
    const cost = gas * gasPrice;
    const size = art.bytecode.object.length / 2 - 1;

    console.log(`  ${label}`);
    console.log(`    bytecode  ${size.toLocaleString()} byte`);
    console.log(`    costo     ~${formatEther(cost)} ETH (${gas.toLocaleString()} gas)`);

    if (dryRun) {
      spent.total += cost;
      return "0x0000000000000000000000000000000000000000";
    }

    const hash = await wallet.deployContract({
      abi: art.abi,
      bytecode: art.bytecode.object,
      args: argsList,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") {
      console.error(`    FALLITO  ${hash}`);
      process.exit(1);
    }
    spent.total += receipt.gasUsed * receipt.effectiveGasPrice;
    console.log(`    indirizzo ${receipt.contractAddress}`);
    return receipt.contractAddress;
  }

  // 1. il silicio — uno per chain
  let gatesAddr = args.gates;
  if (gatesAddr) {
    console.log(`  RH4GateArray  riuso ${gatesAddr} (silicio gia' in chain)`);
  } else {
    gatesAddr = await deploy("RH4GateArray", [], "RH4GateArray — il silicio condiviso");
  }
  console.log();

  // 2. il renderer — anche lui riusabile: e' `pure` e agnostico
  let rendererAddr = args.renderer;
  if (rendererAddr) {
    rendererAddr = getAddress(rendererAddr);
    console.log(`  ChipRenderer  riuso ${rendererAddr}`);
  } else {
    rendererAddr = await deploy("ChipRenderer", [], "ChipRenderer — l'SVG on-chain");
  }
  console.log();

  // 3. la fabbrica
  // Chi deploya non deve per forza restare al comando: setMintPrice,
  // setMother, setRenderer e withdraw sono tutti dell'owner.
  const owner = args.owner ? getAddress(args.owner) : account.address;
  const factoryAddr = await deploy(
    "ChipFactory",
    [gatesAddr, owner],
    `ChipFactory — l'ERC-721 (owner: ${owner === account.address ? "tu" : owner})`
  );
  console.log();

  if (dryRun) {
    console.log(`totale stimato  ~${formatEther(spent.total)} ETH`);
    console.log("\ndry run: non ho mandato niente.");
    return;
  }

  // collego il renderer. Se i poteri sono stati dati a un altro indirizzo
  // questa non possiamo farla noi: la dovra' chiamare l'owner.
  const factoryAbi = artifact("ChipFactory").abi;
  if (owner !== account.address) {
    console.log(`  renderer NON collegato: chiamalo dall'owner`);
    console.log(`    cast send ${factoryAddr} "setRenderer(address)" ${rendererAddr}`);
  } else {
  const setHash = await wallet.writeContract({
    address: factoryAddr,
    abi: factoryAbi,
    functionName: "setRenderer",
    args: [rendererAddr],
  });
  await pub.waitForTransactionReceipt({ hash: setHash });
  console.log("  renderer collegato alla fabbrica");
  }

  // opzionale: conio del primo chip
  let firstChip = null;
  if (args.mint) {
    const { slots } = JSON.parse(fs.readFileSync(args.mint, "utf8"));
    const label = stringToHex(args.label || "Genesis", { size: 32 });
    const ticker = stringToHex(args.ticker || "RH4", { size: 32 });

    // la sigla e' unica: meglio scoprirlo con una view che con una revert
    const free = await pub.readContract({
      address: factoryAddr,
      abi: factoryAbi,
      functionName: "tickerAvailable",
      args: [ticker],
    });
    if (!free) {
      console.error(`  la sigla "${args.ticker || "RH4"}" non e' valida o e' gia' presa`);
      process.exit(1);
    }

    const liquidityBps = Number(args.liquidity ?? 2000);
    const targetCycles = BigInt(args.target ?? 25_920_000); // 30 giorni a 10 Hz

    const hash = await wallet.writeContract({
      address: factoryAddr,
      abi: factoryAbi,
      functionName: "mint",
      args: [slots.map((s) => BigInt(s)), label, ticker, liquidityBps, targetCycles],
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    spent.total += r.gasUsed * r.effectiveGasPrice;
    firstChip = 1;

    const [token, reserve, reward] = await pub.readContract({
      address: factoryAddr,
      abi: factoryAbi,
      functionName: "emission",
      args: [1n],
    });
    console.log(`  token         ${token}`);
    console.log(`    liquidita'  ${liquidityBps / 100}% a te, subito`);
    console.log(`    riserva     ${(Number(reserve) / 1e18).toLocaleString()} token`);
    console.log(`    per ciclo   ${(Number(reward) / 1e18).toLocaleString()} token`);
    console.log(`    durata      ${(Number(targetCycles) / 10 / 3600).toFixed(1)} ore di clock a 10 Hz`);
    console.log(`  chip #1 coniato  ${args.label || "Genesis"} (${args.ticker || "RH4"})  ${r.gasUsed} gas`);
  }

  const explorer = chain.blockExplorers?.default.url;
  console.log("\n--- fatto ---");
  console.log(`  RH4GateArray  ${gatesAddr}`);
  console.log(`  ChipRenderer  ${rendererAddr}`);
  console.log(`  ChipFactory   ${factoryAddr}`);
  console.log(`  speso         ${formatEther(spent.total)} ETH`);
  if (explorer) console.log(`  explorer      ${explorer}/address/${factoryAddr}`);

  if (firstChip) {
    console.log("\nora tieni acceso il chip:");
    console.log(`  RH4_FACTORY=${factoryAddr} node tools/keeper.js --chip 1 --budget 0.01`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
