/**
 * trade.ts — the agent buys and sells, inside a fence.
 *
 * Same road the site's trade panel takes: SwapRouter02, exactInput inside
 * multicall(deadline, bytes[]), address(2) meaning "leave it with the router"
 * and unwrapWETH9 to hand back real ETH. What is different here is that no
 * human is watching, so the fence is in the code:
 *
 *   - trading is OFF unless the operator turns it on (RH4_TRADING)
 *   - only the launchpad's quote tokens, nothing else, ever
 *   - a hard cap per trade, in ETH
 *   - a gas floor the agent may never eat into
 *   - a minimum output computed from the pool, with a capped slippage
 *
 * The chain has no working quoter (the canonical addresses are stubs), so the
 * expected output comes from the pool's own price, hop by hop. That is a spot
 * estimate: on a trade too big for the pool the swap reverts instead of
 * printing a bad fill, which is the direction to fail in.
 *
 * RH4 itself is not tradable here: it has no Uniswap v3 pool, it lives on pons.
 */
import { encodeFunctionData, encodePacked, formatUnits, parseUnits, type Address, type Hex } from "viem";
import { QUOTES, UNI } from "./market.js";
import type { Rh4Client } from "./rh4.js";

export const ROUTER: Address = "0xCaf681a66D020601342297493863E78C959E5cb2";
/** SwapRouter02's "myself": where a hop parks its output before the unwrap. */
const ROUTER_SELF: Address = "0x0000000000000000000000000000000000000002";
const FEE_TIERS = [100, 500, 3000, 10_000] as const;

export const LIMITS = {
  /** never more than this per trade, whatever the operator writes */
  maxTradeEthCeiling: 0.5,
  /** never accept a worse fill than this, whatever the operator writes */
  maxSlippageBps: 500,
  defaults: { tradeMaxEth: 0.01, slippageBps: 200, gasFloorEth: 0.005 },
};

const ROUTER_ABI = [
  { type: "function", name: "exactInput", stateMutability: "payable",
    inputs: [{ type: "tuple", components: [
      { name: "path", type: "bytes" }, { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" } ] }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable",
    inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { type: "function", name: "multicall", stateMutability: "payable",
    inputs: [{ name: "deadline", type: "uint256" }, { name: "data", type: "bytes[]" }], outputs: [{ type: "bytes[]" }] },
] as const;
const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
] as const;
const V3F_ABI = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export interface Asset { sym: string; address: Address; decimals: number; isNative: boolean }

/** "eth", "NVDA", "$spy" resolved against the launchpad's own list. Nothing else passes. */
export function asset(symRaw: string): Asset | undefined {
  const sym = symRaw.trim().replace(/^\$/, "").toUpperCase();
  if (sym === "ETH") return { sym: "ETH", address: UNI.weth, decimals: 18, isNative: true };
  const q = QUOTES[sym];
  return q ? { sym, address: q.address, decimals: q.decimals, isNative: false } : undefined;
}
export const tradableSymbols = (): string[] => ["ETH", ...Object.keys(QUOTES).filter((s) => s !== "WETH")];

interface Hop { pool: Address; fee: number; tokenIn: Address; tokenOut: Address; sqrt: bigint }

/** The deepest pool of the two, or none: liquidity decides, not a hardcoded tier. */
async function bestPool(rh4: Rh4Client, a: Address, b: Address): Promise<{ pool: Address; fee: number; sqrt: bigint } | null> {
  const found = await Promise.all(FEE_TIERS.map(async (fee) => {
    const pool = await rh4.pub.readContract({ address: UNI.v3Factory, abi: V3F_ABI, functionName: "getPool", args: [a, b, fee] }).catch(() => null);
    if (!pool || /^0x0{40}$/.test(pool)) return null;
    const [liq, s0] = await Promise.all([
      rh4.pub.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" }).catch(() => 0n),
      rh4.pub.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }).catch(() => null),
    ]);
    if (!s0 || liq === 0n) return null;
    return { pool, fee, liq: liq as bigint, sqrt: s0[0] as bigint };
  }));
  const live = found.filter(Boolean) as { pool: Address; fee: number; liq: bigint; sqrt: bigint }[];
  if (!live.length) return null;
  live.sort((x, y) => (y.liq > x.liq ? 1 : y.liq < x.liq ? -1 : 0));
  return { pool: live[0].pool, fee: live[0].fee, sqrt: live[0].sqrt };
}

/** The route: straight if one side is ether, otherwise through WETH. */
export async function route(rh4: Rh4Client, from: Asset, to: Asset): Promise<Hop[]> {
  const legs: [Address, Address][] =
    from.address.toLowerCase() === UNI.weth.toLowerCase() || to.address.toLowerCase() === UNI.weth.toLowerCase()
      ? [[from.address, to.address]]
      : [[from.address, UNI.weth], [UNI.weth, to.address]];
  const hops: Hop[] = [];
  for (const [a, b] of legs) {
    const p = await bestPool(rh4, a, b);
    if (!p) throw new Error(`no Uniswap pool between ${a === from.address ? from.sym : "WETH"} and ${b === to.address ? to.sym : "WETH"} on this chain`);
    hops.push({ pool: p.pool, fee: p.fee, tokenIn: a, tokenOut: b, sqrt: p.sqrt });
  }
  return hops;
}

/** Spot price of one hop, from the pool's own sqrtPriceX96, fee taken off. */
function hopOut(amountIn: bigint, hop: Hop, decIn: number, decOut: number): bigint {
  const zeroForOne = hop.tokenIn.toLowerCase() < hop.tokenOut.toLowerCase();
  const Q = 2 ** 96;
  const sqrt = Number(hop.sqrt) / Q;
  const priceOneForZero = sqrt * sqrt;            // token1 per token0, raw units
  const raw = zeroForOne ? priceOneForZero : 1 / priceOneForZero;
  // raw price is out-raw per in-raw: to whole units it moves by the decimal gap
  // of the INPUT minus the output (USDG has 6, everything else 18)
  const scaled = raw * 10 ** (decIn - decOut);
  const inWhole = Number(formatUnits(amountIn, decIn));
  const out = inWhole * scaled * (1 - hop.fee / 1_000_000);
  if (!isFinite(out) || out <= 0) return 0n;
  return parseUnits(out.toFixed(Math.min(18, decOut)), decOut);
}

/** What the pools say the trade is worth right now, before slippage. */
export async function expectedOut(rh4: Rh4Client, from: Asset, to: Asset, amountIn: bigint, hops?: Hop[]) {
  const path = hops ?? (await route(rh4, from, to));
  let amt = amountIn;
  let dec = from.decimals;
  for (const h of path) {
    const decOut = h.tokenOut.toLowerCase() === to.address.toLowerCase() ? to.decimals : 18;   // WETH in the middle
    amt = hopOut(amt, h, dec, decOut);
    dec = decOut;
  }
  return { out: amt, hops: path };
}

export interface TradePolicy { enabled: boolean; maxTradeEth: number; slippageBps: number; gasFloorEth: number }

export function policyOf(cfg: { trading?: boolean; tradeMaxEth?: number; slippageBps?: number; gasFloorEth?: number }): TradePolicy {
  const d = LIMITS.defaults;
  return {
    enabled: Boolean(cfg.trading),
    maxTradeEth: Math.min(cfg.tradeMaxEth ?? d.tradeMaxEth, LIMITS.maxTradeEthCeiling),
    slippageBps: Math.min(cfg.slippageBps ?? d.slippageBps, LIMITS.maxSlippageBps),
    gasFloorEth: cfg.gasFloorEth ?? d.gasFloorEth,
  };
}

/** How much ether a leg is worth, to measure a trade against the cap. */
async function ethValueOf(rh4: Rh4Client, a: Asset, amount: bigint): Promise<number> {
  if (a.address.toLowerCase() === UNI.weth.toLowerCase()) return Number(formatUnits(amount, 18));
  const p = await bestPool(rh4, a.address, UNI.weth);
  if (!p) return Infinity;                                  // unknown price: treat as over the cap
  const out = hopOut(amount, { pool: p.pool, fee: p.fee, tokenIn: a.address, tokenOut: UNI.weth, sqrt: p.sqrt }, a.decimals, 18);
  return Number(formatUnits(out, 18));
}

export interface TradeResult {
  hash: Hex; from: Asset; to: Asset; amountIn: bigint; expected: bigint; minOut: bigint;
  received: bigint; fees: number[]; ethValue: number; gas: bigint;
}

/** One swap, inside the fence. Everything is checked before anything is signed. */
export async function trade(rh4: Rh4Client, p: {
  from: Asset; to: Asset; amountIn: bigint; policy: TradePolicy;
}): Promise<TradeResult> {
  const { from, to, amountIn, policy } = p;
  const { wallet, account } = rh4.requireWallet();
  if (!policy.enabled) throw new Error("trading is off: the operator has not set RH4_TRADING=on");
  if (from.sym === to.sym) throw new Error("that is the same asset on both sides");
  if (amountIn <= 0n) throw new Error("amount must be positive");

  const ethValue = await ethValueOf(rh4, from, amountIn);
  if (!(ethValue <= policy.maxTradeEth)) {
    throw new Error(`that trade is worth about ${ethValue === Infinity ? "an unknown amount of" : ethValue.toFixed(4)} ETH, over my ${policy.maxTradeEth} ETH per-trade cap`);
  }

  const ethBal = await rh4.pub.getBalance({ address: account.address });
  const floor = parseUnits(String(policy.gasFloorEth), 18);
  if (from.isNative) {
    if (ethBal < amountIn + floor) throw new Error(`not enough ETH: I hold ${formatUnits(ethBal, 18)} and must keep ${policy.gasFloorEth} for gas`);
  } else {
    if (ethBal < floor) throw new Error(`only ${formatUnits(ethBal, 18)} ETH left, below my ${policy.gasFloorEth} gas floor: I need gas before I can trade`);
    const bal = await rh4.pub.readContract({ address: from.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    if (bal < amountIn) throw new Error(`I hold ${formatUnits(bal, from.decimals)} ${from.sym}, not ${formatUnits(amountIn, from.decimals)}`);
  }

  const { out: expected, hops } = await expectedOut(rh4, from, to, amountIn);
  if (expected <= 0n) throw new Error("the pools give no usable price for that pair right now");
  const minOut = (expected * BigInt(10_000 - policy.slippageBps)) / 10_000n;

  // approve, only what this trade needs
  if (!from.isNative) {
    const allowance = await rh4.pub.readContract({ address: from.address, abi: ERC20_ABI, functionName: "allowance", args: [account.address, ROUTER] });
    if (allowance < amountIn) {
      const { request } = await rh4.pub.simulateContract({ account, address: from.address, abi: ERC20_ABI, functionName: "approve", args: [ROUTER, amountIn] });
      const h = await wallet.writeContract(request);
      await rh4.pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
    }
  }

  // path: token, fee, token, fee, token…
  const parts: (Address | number)[] = [hops[0].tokenIn];
  for (const h of hops) parts.push(h.fee, h.tokenOut);
  const types = parts.map((_, i) => (i % 2 === 0 ? "address" : "uint24"));
  const path = encodePacked(types as never, parts as never);

  const toNative = to.isNative;
  const calls: Hex[] = [
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInput",
      args: [{ path, recipient: toNative ? ROUTER_SELF : account.address, amountIn, amountOutMinimum: minOut }] }),
  ];
  if (toNative) calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [minOut, account.address] }));

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const before = toNative
    ? await rh4.pub.getBalance({ address: account.address })
    : await rh4.pub.readContract({ address: to.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });

  const { request } = await rh4.pub.simulateContract({
    account, address: ROUTER, abi: ROUTER_ABI, functionName: "multicall",
    args: [deadline, calls], value: from.isNative ? amountIn : 0n,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await rh4.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("the swap reverted on-chain: the pool moved past the floor, try a smaller size");

  const after = toNative
    ? await rh4.pub.getBalance({ address: account.address })
    : await rh4.pub.readContract({ address: to.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  const spentGas = receipt.gasUsed * receipt.effectiveGasPrice;
  const received = toNative ? (after > before ? after - before + spentGas : 0n) : after - before;

  return { hash, from, to, amountIn, expected, minOut, received, fees: hops.map((h) => h.fee), ethValue, gas: receipt.gasUsed };
}
