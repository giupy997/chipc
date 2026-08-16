#!/usr/bin/env node
/**
 * deploy.js — mette il processore sulla chain.
 *
 *   PRIVATE_KEY=0x... node tools/deploy.js --program build/forever.slots.json
 *
 *     --program FILE   ROM impacchettata prodotta da tools/asm.js
 *     --rpc URL        default: mainnet Robinhood Chain
 *     --dry-run        calcola tutto e dice quanto costa, senza mandare
 *
 * Chi manda questa transazione diventa `operator`: e' l'unico che potra'
 * cambiare programma o resettare la macchina. Il clock invece resta di
 * nessuno — `tick()` e' aperto a chiunque.
 */

const fs = require("fs");
const {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  encodeDeployData,
} = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const ARTIFACT = "out/RH4.sol/RH4.json";

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run"]);
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  const programPath = args.program || "build/rom.slots.json";
  const dryRun = Boolean(args["dry-run"]);

  if (!fs.existsSync(ARTIFACT)) {
    console.error(`manca ${ARTIFACT} — compila prima con "make gates && forge build"`);
    process.exit(2);
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const bytecode = artifact.bytecode.object;
  const { slots } = JSON.parse(fs.readFileSync(programPath, "utf8"));
  if (slots.length !== 16) {
    console.error(`${programPath}: attesi 16 slot di ROM, trovati ${slots.length}`);
    process.exit(2);
  }

  const chain = chainFor(rpc);
  const account = accountFromEnv();
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  const args_ = [slots.map((s) => BigInt(s))];
  const gas = await pub.estimateGas({
    account,
    data: encodeDeployData({ abi: artifact.abi, bytecode, args: args_ }),
  });
  const gasPrice = await pub.getGasPrice();
  const balance = await pub.getBalance({ address: account.address });

  console.log("deploy RH-4");
  console.log(`  rete        ${chain.name} (${chain.id}) via ${rpc}`);
  console.log(`  operatore   ${account.address}  (${formatEther(balance)} ETH)`);
  console.log(`  programma   ${programPath}`);
  console.log(`  bytecode    ${(bytecode.length / 2 - 1).toLocaleString()} byte`);
  console.log(`  costo       ~${formatEther(gas * gasPrice)} ETH (${gas} gas)`);

  if (dryRun) {
    console.log("\ndry run: non mando niente.");
    return;
  }
  if (balance < gas * gasPrice) {
    console.error("\nfondi insufficienti.");
    process.exit(1);
  }

  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode,
    args: args_,
  });
  console.log(`\n  tx  ${hash}`);

  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") {
    console.error("deploy fallito.");
    process.exit(1);
  }

  console.log(`  processore  ${receipt.contractAddress}`);
  console.log(`  speso       ${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} ETH`);
  if (chain.blockExplorers) {
    console.log(`  explorer    ${chain.blockExplorers.default.url}/address/${receipt.contractAddress}`);
  }
  console.log(`\nora il clock:\n  RH4_ADDRESS=${receipt.contractAddress} node tools/keeper.js --budget 0.01`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
