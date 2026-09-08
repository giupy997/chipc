/**
 * market.ts — opening a chip token's market, the way the site does it.
 *
 * One Uniswap v3 position, born straight inside a fee vault: a single-sided
 * range order from 5 ETH of FDV up to the max tick, no ceiling. The vault
 * has no withdraw, transfer or burn: the liquidity is sealed forever, and
 * only the 1% trading fees move — split by the vault the agent picks:
 *
 *   creator  50% to the chip's minter (claimable), 50% reserve + RH4 buyback
 *   holders  80% to the token's holders (epochs, pushed), 20% reserve + buyback
 *   reserve  100% reserve + RH4 buyback
 *
 * Mirrors docs/chip.js walletOpenMarket on the site, address for address.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { Rh4Client } from "./rh4.js";

export const UNI = {
  npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" as Address,
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  fee: 10_000, spacing: 200, tickEdge: 887_200,
  fdvStartEth: 5, supply: 1e9,
  minOpen: 10_000_000n * 10n ** 18n,   // below 1% of the supply a market is a trap
};

/** Where the position is born: the ChipFactory9 vaults (Sep 8 2026). */
export const VAULTS: Record<"creator" | "holders" | "reserve", Address> = {
  creator: "0x094943a2ff18b4d3b28a05A37E5dF10599a9223B",
  holders: "0xFBB3bac91aeFb37277318a74D0D13D118b1B12AA",
  reserve: "0x64F26350754f33ea0F9C5A2771a4757435623533",
};
export type FeeMode = keyof typeof VAULTS;

/** Quotes the launchpad offers, same list as the site's config.js. */
export const QUOTES: Record<string, { address: Address; decimals: number }> = {
  WETH: { address: UNI.weth, decimals: 18 },
  NVDA: { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18 },
  SNDK: { address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", decimals: 18 },
  MU:   { address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", decimals: 18 },
  TSM:  { address: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", decimals: 18 },
  AAPL: { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18 },
  QUBT: { address: "0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4", decimals: 18 },
  SPCX: { address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", decimals: 18 },
  TSLA: { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18 },
  SPY:  { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18 },
  MSTR: { address: "0xec262a75e413fAfD0dF80480274532C79D42da09", decimals: 18 },
  COIN: { address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", decimals: 18 },
  RDDT: { address: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C", decimals: 18 },
  USDG: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 },
};

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const V3F_ABI = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;
const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
] as const;
const NPM_ABI = [
  { type: "function", name: "createAndInitializePoolIfNecessary", stateMutability: "payable",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "uint160" }], outputs: [{ type: "address" }] },
  { type: "function", name: "mint", stateMutability: "payable",
    inputs: [{ type: "tuple", components: [
      { name: "token0", type: "address" }, { name: "token1", type: "address" }, { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
      { name: "amount0Desired", type: "uint256" }, { name: "amount1Desired", type: "uint256" },
      { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
      { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" } ] }],
    outputs: [{ type: "uint256" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ type: "bytes[]" }], outputs: [{ type: "bytes[]" }] },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

/** Uniswap's TickMath.getSqrtRatioAtTick, bit for bit. */
export function sqrtRatioAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick));
  const Q128 = 1n << 128n;
  let ratio = (abs & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
  const muls: [bigint, bigint][] = [
    [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, m] of muls) if ((abs & bit) !== 0n) ratio = (ratio * m) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  const shifted = ratio >> 32n;
  return shifted + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
export const tickAtPrice = (p: number) => Math.floor(Math.log(p) / Math.log(1.0001));
export const floorSpacing = (t: number, sp: number) => Math.floor(t / sp) * sp;

/** ETH per one human unit of a quote, from its deepest WETH pool. */
export async function ethPerQuote(rh4: Rh4Client, quote: Address, decimals: number): Promise<{ rate: number; fee: number }> {
  let best: { pool: Address; depth: bigint; t0: Address; fee: number } | null = null;
  for (const fee of [100, 500, 3000, 10_000]) {
    const [t0, t1] = quote.toLowerCase() < UNI.weth.toLowerCase() ? [quote, UNI.weth] : [UNI.weth, quote];
    const pool = await rh4.pub.readContract({ address: UNI.v3Factory, abi: V3F_ABI, functionName: "getPool", args: [t0, t1, fee] });
    if (pool === ZERO) continue;
    const depth = await rh4.pub.readContract({ address: UNI.weth, abi: ERC20_ABI, functionName: "balanceOf", args: [pool] });
    if (!best || depth > best.depth) best = { pool, depth, t0, fee };
  }
  if (!best || best.depth < 5n * 10n ** 16n) throw new Error("no usable WETH pool for this quote — open vs WETH instead");
  const [sqrtX96] = await rh4.pub.readContract({ address: best.pool, abi: POOL_ABI, functionName: "slot0" });
  const p = Number(sqrtX96) ** 2 / 2 ** 192;              // token1 per token0, raw units
  const raw = best.t0.toLowerCase() === UNI.weth.toLowerCase() ? 1 / p : p;
  return { rate: raw / 10 ** (18 - decimals), fee: best.fee };
}

export interface OpenMarketParams { chipId: number; pair?: string; feeMode?: FeeMode }

/** Open the market of a chip token from the agent's own token balance. */
export async function openMarket(rh4: Rh4Client, p: OpenMarketParams) {
  const { wallet, account } = rh4.requireWallet();
  const pairKey = (p.pair ?? "WETH").toUpperCase();
  const quote = QUOTES[pairKey];
  if (!quote) throw new Error(`unknown pair "${pairKey}" — one of ${Object.keys(QUOTES).join(", ")}`);
  const feeMode: FeeMode = p.feeMode ?? "creator";
  const vault = VAULTS[feeMode];

  const chip = await rh4.chipState(p.chipId);
  const token = chip.token;
  if (token === ZERO) throw new Error(`chip #${p.chipId} has no token`);
  const balance = await rh4.pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  if (balance === 0n) throw new Error(`this wallet holds no ${chip.ticker} — mint the chip (the liquidity slice lands here) or mine a few cycles first`);
  if (balance < UNI.minOpen) throw new Error(`too thin to open a market: ${balance / 10n ** 18n} ${chip.ticker} in the wallet, at least 10,000,000 (1% of supply) are needed`);

  const ourIsToken0 = token.toLowerCase() < quote.address.toLowerCase();
  const [t0, t1] = ourIsToken0 ? [token, quote.address] : [quote.address, token];
  const existing = await rh4.pub.readContract({ address: UNI.v3Factory, abi: V3F_ABI, functionName: "getPool", args: [t0, t1, UNI.fee] });
  if (existing !== ZERO) throw new Error(`the ${chip.ticker}/${pairKey} market already exists at ${existing}`);

  const { rate } = pairKey === "WETH" ? { rate: 1 } : await ethPerQuote(rh4, quote.address, quote.decimals);
  const qStart = UNI.fdvStartEth / rate;
  const pRaw = (qStart / UNI.supply) / 10 ** (18 - quote.decimals);   // raw quote per raw token
  let lo: number, hi: number, init: number;
  if (ourIsToken0) { lo = floorSpacing(tickAtPrice(pRaw), UNI.spacing); hi = UNI.tickEdge; init = lo; }
  else { lo = -UNI.tickEdge; hi = floorSpacing(tickAtPrice(1 / pRaw), UNI.spacing); init = hi; }
  const sqrtX96 = sqrtRatioAtTick(init);

  // 1/2 approve, only if needed
  const allowance = await rh4.pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [account.address, UNI.npm] });
  let approveHash: Hex | undefined;
  if (allowance < balance) {
    const { request } = await rh4.pub.simulateContract({ account, address: token, abi: ERC20_ABI, functionName: "approve", args: [UNI.npm, balance] });
    approveHash = await wallet.writeContract(request);
    const r1 = await rh4.pub.waitForTransactionReceipt({ hash: approveHash, timeout: 120_000 });
    if (r1.status !== "success") throw new Error("approve reverted on-chain");
  }

  // 2/2 create + initialize the pool and mint the range order straight into the vault
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const createCall = encodeFunctionData({ abi: NPM_ABI, functionName: "createAndInitializePoolIfNecessary", args: [t0, t1, UNI.fee, sqrtX96] });
  const mintCall = encodeFunctionData({ abi: NPM_ABI, functionName: "mint", args: [{
    token0: t0, token1: t1, fee: UNI.fee, tickLower: lo, tickUpper: hi,
    amount0Desired: ourIsToken0 ? balance : 0n, amount1Desired: ourIsToken0 ? 0n : balance,
    amount0Min: 0n, amount1Min: 0n, recipient: vault, deadline,
  }] });
  const { request } = await rh4.pub.simulateContract({ account, address: UNI.npm, abi: NPM_ABI, functionName: "multicall", args: [[createCall, mintCall]] });
  const hash = await wallet.writeContract(request);
  const receipt = await rh4.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("market open reverted on-chain");
  const pool = await rh4.pub.readContract({ address: UNI.v3Factory, abi: V3F_ABI, functionName: "getPool", args: [t0, t1, UNI.fee] });
  return { hash, approveHash, pool, vault, feeMode, pair: pairKey, tokens: balance, ticker: chip.ticker, block: receipt.blockNumber };
}
