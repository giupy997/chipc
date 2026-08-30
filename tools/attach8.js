#!/usr/bin/env node
/**
 * attach8.js — aggancia a un chip nudo un token nato su un launchpad,
 * finanziando la riserva NELL'ORDINE GIUSTO.
 *
 * Il contratto rifiuta l'aggancio a riserva vuota (un tick a riserva zero
 * spegnerebbe l'emissione per sempre), quindi questo strumento fa le due
 * cose in fila: prima trasferisce la riserva alla fabbrica, poi aggancia.
 *
 *   PRIVATE_KEY=...  RH4_FACTORY=0x...  node tools/attach8.js \
 *     --chip 1 --token 0x... --reserve 400000000 --target 77760000
 *
 *   --reserve N   token da mandare in riserva (unita' intere, non wei)
 *   --target N    cicli su cui spalmarla: reward = riserva / target
 *                 (default 77.760.000 = 90 giorni a 10 Hz)
 *   --skip-fund   la riserva e' gia' nella fabbrica: solo l'aggancio
 *   --dry-run     mostra i numeri e non manda niente
 */

const { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits, getAddress } = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const ABI = parseAbi([
  "function attachToken(uint256 id, address token, uint96 rewardPerCycle)",
  "function emission(uint256 id) view returns (address token, uint256 reserveLeft, uint256 rewardPerCycle, uint256 cyclesLeft)",
  "function ownerOf(uint256 id) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "skip-fund"]);
  const factory = getAddress(process.env.RH4_FACTORY || "");
  const chipId = BigInt(args.chip ?? 1);
  const token = getAddress(args.token || "");
  const target = BigInt(args.target ?? 77_760_000);

  const rpc = process.env.RH4_RPC || DEFAULT_RPC;
  const chain = chainFor(rpc);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const account = accountFromEnv();
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  const [decimals, symbol, chipOwner] = await Promise.all([
    pub.readContract({ address: token, abi: ABI, functionName: "decimals" }),
    pub.readContract({ address: token, abi: ABI, functionName: "symbol" }),
    pub.readContract({ address: factory, abi: ABI, functionName: "ownerOf", args: [chipId] }),
  ]);
  if (chipOwner !== account.address) {
    console.error(`il chip #${chipId} e' di ${chipOwner}, non del tuo wallet ${account.address}`);
    process.exit(1);
  }

  const inFactory = await pub.readContract({ address: token, abi: ABI, functionName: "balanceOf", args: [factory] });
  const inWallet = await pub.readContract({ address: token, abi: ABI, functionName: "balanceOf", args: [account.address] });

  let toSend = 0n;
  if (!args["skip-fund"]) {
    if (!args.reserve) { console.error("manca --reserve (o usa --skip-fund se e' gia' dentro)"); process.exit(2); }
    toSend = parseUnits(String(args.reserve), decimals);
    if (toSend > inWallet) {
      console.error(`vuoi mandare ${args.reserve} ${symbol} ma il wallet ne ha ${formatUnits(inWallet, decimals)}`);
      process.exit(1);
    }
  }

  const reserve = inFactory + toSend;
  if (reserve === 0n) { console.error("riserva zero: senza --reserve non c'e' niente da distribuire"); process.exit(1); }
  const reward = reserve / target;
  if (reward === 0n) { console.error("riserva/target = 0: target troppo alto per questa riserva"); process.exit(1); }
  if (reward > (1n << 96n) - 1n) { console.error("reward oltre uint96"); process.exit(1); }

  console.log("aggancio token esterno");
  console.log(`  fabbrica   ${factory}  chip #${chipId}`);
  console.log(`  token      ${token} (${symbol})`);
  console.log(`  riserva    ${formatUnits(reserve, decimals)} ${symbol}` + (toSend ? ` (${formatUnits(toSend, decimals)} da trasferire ora)` : " (gia' in fabbrica)"));
  console.log(`  per ciclo  ${formatUnits(reward, decimals)} ${symbol} su ${target} cicli`);
  console.log(`  durata     ${(Number(target) / 10 / 86400).toFixed(1)} giorni di clock pieno a 10 Hz`);

  if (args["dry-run"]) { console.log("\ndry run: non ho mandato niente."); return; }

  if (toSend > 0n) {
    const th = await wallet.writeContract({ address: token, abi: ABI, functionName: "transfer", args: [factory, toSend] });
    await pub.waitForTransactionReceipt({ hash: th });
    console.log(`\n  1/2 riserva trasferita  ${th.slice(0, 18)}…`);
  }

  const ah = await wallet.writeContract({
    address: factory, abi: ABI, functionName: "attachToken",
    args: [chipId, token, reward],
  });
  await pub.waitForTransactionReceipt({ hash: ah });
  console.log(`  2/2 token agganciato    ${ah.slice(0, 18)}…`);

  const [t, left, rpc_, cyc] = await pub.readContract({ address: factory, abi: ABI, functionName: "emission", args: [chipId] });
  console.log(`\nverifica on-chain: token ${t}`);
  console.log(`  riserva ${formatUnits(left, decimals)} ${symbol}, ${formatUnits(rpc_, decimals)}/ciclo, ${cyc} cicli davanti`);
  console.log("il clock ora paga: tienilo acceso col keeper.");
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
