#!/usr/bin/env node
/**
 * reserve8.js — riserva le sigle del progetto prima che lo faccia qualcun altro.
 *
 * La fabbrica rende ogni sigla unica per sempre, ma mint() e' aperta a
 * chiunque: le sigle delle generazioni annunciate in roadmap e le varianti
 * confondibili vanno prese prima dell'annuncio, non dopo.
 *
 * Conia chip NUDI (targetCycles = 0): niente token, ROM vuota (tutti nop),
 * ~250k gas l'uno. Sono segnaposto, non prodotti — il giorno che RH-16
 * esiste davvero, il suo chip vero nascera' altrove; questi tengono solo
 * il nome al sicuro.
 *
 *   PRIVATE_KEY=...  RH4_FACTORY=0x...  node tools/reserve8.js RH8 RH16 RH32
 *   --dry-run        mostra cosa farebbe senza mandare nulla
 */

const { createPublicClient, createWalletClient, http, parseAbi } = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const ABI = parseAbi([
  "function mint(uint256[128] words, bytes32 label, bytes32 ticker, string logoURI, uint16 liquidityBps, uint64 targetCycles) payable returns (uint256 id, address token)",
  "function chipByTicker(bytes32 ticker) view returns (uint256)",
  "function mintPrice() view returns (uint256)",
]);

function tickerBytes(s) {
  const up = s.toUpperCase();
  if (!/^[A-Z0-9-]{1,8}$/.test(up)) {
    throw new Error(`sigla non valida: "${s}" (1-8 fra A-Z, 0-9 e trattino)`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < up.length; i++) bytes[i] = up.charCodeAt(i);
  return "0x" + Buffer.from(bytes).toString("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run"]);
  const tickers = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!tickers.length) {
    console.error("uso: node tools/reserve8.js SIGLA [SIGLA...] [--dry-run]");
    process.exit(2);
  }
  const factory = process.env.RH4_FACTORY;
  if (!factory) { console.error("manca RH4_FACTORY nell'ambiente"); process.exit(2); }

  const rpc = process.env.RH4_RPC || DEFAULT_RPC;
  const chain = chainFor(rpc);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const account = accountFromEnv();
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  const price = await pub.readContract({ address: factory, abi: ABI, functionName: "mintPrice" });
  const emptyRom = Array(128).fill(0n);

  console.log("riservo sigle nella fabbrica");
  console.log(`  fabbrica   ${factory}`);
  console.log(`  wallet     ${account.address}`);
  console.log("");

  for (const t of tickers) {
    const tb = tickerBytes(t);
    const taken = await pub.readContract({
      address: factory, abi: ABI, functionName: "chipByTicker", args: [tb],
    });
    if (taken !== 0n) {
      console.log(`  ${t.toUpperCase().padEnd(8)} gia' presa (chip #${taken}) — salto`);
      continue;
    }
    if (args["dry-run"]) {
      console.log(`  ${t.toUpperCase().padEnd(8)} libera — la prenderei (chip nudo, zero token)`);
      continue;
    }
    const hash = await wallet.writeContract({
      address: factory, abi: ABI, functionName: "mint",
      args: [emptyRom, tb, tb, "", 0, 0n],
      value: price,
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${t.toUpperCase().padEnd(8)} riservata — tx ${hash.slice(0, 18)}… (${rcpt.gasUsed} gas)`);
  }

  console.log("\nfatto. I segnaposto sono NFT nel tuo wallet: nessun token, nessuna ROM.");
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
