#!/usr/bin/env node
/**
 * buy.js — compra il token di un chip pagando in ETH, via SwapRouter.
 *
 * Il router incarta l'ETH da solo (tokenIn = WETH + msg.value) e la path
 * multi-hop attraversa il pool del cambio quando il chip e' pairato NVDA.
 *
 *   PRIVATE_KEY=... node tools/buy.js --token 0x... --eth 0.001            # pair WETH
 *   PRIVATE_KEY=... node tools/buy.js --token 0x... --eth 0.001 --via nvda # pair NVDA
 */
const { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther, getAddress, encodePacked } = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const ROUTER = "0xCaF681a66D020601342297493863e78c959E5cB2";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

const ABI = parseAbi([
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

async function main() {
  const args = parseArgs(process.argv.slice(2), []);
  const token = getAddress(args.token || "");
  const eth = parseEther(String(args.eth || "0.001"));
  const viaNvda = (args.via || "").toLowerCase() === "nvda";

  const rpc = process.env.RH4_RPC || DEFAULT_RPC;
  const chain = chainFor(rpc);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const account = accountFromEnv();
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  // path: WETH -> [NVDA ->] token. Fee del cambio 500, fee dei chip 10000.
  const path = viaNvda
    ? encodePacked(["address", "uint24", "address", "uint24", "address"], [WETH, 500, NVDA, 10000, token])
    : encodePacked(["address", "uint24", "address"], [WETH, 10000, token]);

  const sym = await pub.readContract({ address: token, abi: ABI, functionName: "symbol" });
  const before = await pub.readContract({ address: token, abi: ABI, functionName: "balanceOf", args: [account.address] });

  console.log(`compro ${sym} con ${formatEther(eth)} ETH ${viaNvda ? "(via NVDA)" : "(diretto)"}`);
  const hash = await wallet.writeContract({
    address: ROUTER, abi: ABI, functionName: "exactInput",
    args: [{ path, recipient: account.address,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      amountIn: eth, amountOutMinimum: 0n }],
    value: eth,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") { console.error("swap fallito — guarda l'explorer:", hash); process.exit(1); }

  const after = await pub.readContract({ address: token, abi: ABI, functionName: "balanceOf", args: [account.address] });
  console.log(`fatto: +${formatEther(after - before)} ${sym}`);
  console.log(`tx ${hash}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
