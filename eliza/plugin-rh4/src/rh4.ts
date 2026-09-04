/**
 * rh4.ts — the chain core of the plugin.
 *
 * Everything the actions do on Robinhood Chain goes through here: one
 * public client for reading, one wallet client (only if the agent has a
 * key) for minting and ticking. The ABIs are hand-picked fragments of the
 * verified ChipFactory8 — no codegen, no surprises.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  stringToHex,
  formatEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const DEFAULTS = {
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  factory: "0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b" as Address,
  explorer: "https://robinhoodchain.blockscout.com",
  site: "https://rh4cpu.tech",
};

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULTS.rpc] } },
  blockExplorers: {
    default: { name: "Blockscout", url: DEFAULTS.explorer },
  },
});

export const FACTORY_ABI = [
  { type: "function", name: "totalChips", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintPrice", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "chipByTicker", stateMutability: "view",
    inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "chip", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "machine", type: "uint256" },
      { name: "label", type: "bytes32" },
      { name: "ticker", type: "bytes32" },
      { name: "minter", type: "address" },
      { name: "bornBlock", type: "uint64" },
      { name: "resets", type: "uint32" },
      { name: "token", type: "address" },
      { name: "rewardPerCycle", type: "uint96" },
    ] }] },
  { type: "function", name: "inspect", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "pc", type: "uint16" },
      { name: "out", type: "uint8" },
      { name: "halted", type: "bool" },
      { name: "cycles", type: "uint256" },
      { name: "lastTickBlock", type: "uint256" },
    ] },
  { type: "function", name: "emission", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "reserveLeft", type: "uint256" },
      { name: "rewardPerCycle", type: "uint256" },
      { name: "cyclesLeft", type: "uint256" },
    ] },
  { type: "function", name: "tick", stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "inPort", type: "uint8" },
    ],
    outputs: [
      { name: "pc_", type: "uint16" },
      { name: "out_", type: "uint8" },
      { name: "halted_", type: "bool" },
    ] },
  { type: "function", name: "mint", stateMutability: "payable",
    inputs: [
      { name: "words", type: "uint256[128]" },
      { name: "label", type: "bytes32" },
      { name: "ticker", type: "bytes32" },
      { name: "logoURI", type: "string" },
      { name: "liquidityBps", type: "uint16" },
      { name: "targetCycles", type: "uint64" },
    ],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "token", type: "address" },
    ] },
  { type: "event", name: "ChipMinted",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "minter", type: "address", indexed: true },
      { name: "ticker", type: "bytes32", indexed: true },
      { name: "label", type: "bytes32" },
    ] },
  { type: "event", name: "Cycle",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "cycle", type: "uint256", indexed: true },
      { name: "sponsor", type: "address", indexed: true },
      { name: "pc", type: "uint16" },
      { name: "inPort", type: "uint8" },
      { name: "out", type: "uint8" },
      { name: "halted", type: "bool" },
    ] },
  { type: "error", name: "NoSuchChip", inputs: [] },
  { type: "error", name: "OneTickPerBlock", inputs: [] },
  { type: "error", name: "AlreadyHalted", inputs: [] },
  { type: "error", name: "WrongPayment", inputs: [] },
  { type: "error", name: "TickerTaken", inputs: [{ name: "existingChip", type: "uint256" }] },
  { type: "error", name: "BadTicker", inputs: [] },
  { type: "error", name: "BadLiquidityShare", inputs: [] },
  { type: "error", name: "TargetTooShort", inputs: [] },
] as const;

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view",
    inputs: [], outputs: [{ type: "string" }] },
] as const;

/**
 * The stock program every agent-minted chip ships with: echo8. It listens
 * forever — echoes the byte the sponsor sends and keeps a running sum in
 * RAM. Perfect as an agent's heartbeat: every tick engraves one byte of
 * the agent's choosing into the Cycle event log, permanently.
 *
 * Generated from the same build/echo.slots8.json the site uses.
 */
export const ECHO_ROM: bigint[] = (() => {
  const slots = new Array<bigint>(128).fill(0n);
  slots[0] = BigInt("0x162000001412000003200000000000001321000001100100160000001500000");
  slots[1] = BigInt("0x1700000");
  return slots;
})();

export interface Rh4Config {
  rpc: string;
  factory: Address;
  privateKey?: Hex;
  /** the chip this agent considers its own (for the provider) */
  agentChipId?: number;
}

export interface ChipState {
  id: number;
  label: string;
  ticker: string;
  minter: Address;
  token: Address;
  pc: number;
  out: number;
  halted: boolean;
  cycles: bigint;
  behindBlocks: bigint;
  reserveLeft: bigint;
  rewardPerCycle: bigint;
  cyclesLeft: bigint;
}

const b32ToString = (b: Hex): string => {
  const hex = b.slice(2);
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
};

export const toB32 = (s: string): Hex => stringToHex(s, { size: 32 });

export class Rh4Client {
  readonly cfg: Rh4Config;
  readonly pub: PublicClient;
  private wallet?: WalletClient;
  private account?: Account;

  constructor(cfg: Rh4Config) {
    this.cfg = cfg;
    const chain = cfg.rpc === DEFAULTS.rpc
      ? robinhoodChain
      : { ...robinhoodChain, rpcUrls: { default: { http: [cfg.rpc] } } };
    this.pub = createPublicClient({ chain, transport: http(cfg.rpc) }) as PublicClient;
    if (cfg.privateKey) {
      this.account = privateKeyToAccount(cfg.privateKey);
      this.wallet = createWalletClient({ account: this.account, chain, transport: http(cfg.rpc) });
    }
  }

  get address(): Address | undefined { return this.account?.address; }

  requireWallet(): { wallet: WalletClient; account: Account } {
    if (!this.wallet || !this.account) {
      throw new Error(
        "No RH4_PRIVATE_KEY configured — reading works, but minting and " +
        "ticking need a funded wallet on Robinhood Chain (use a dedicated, " +
        "low-value key for the agent)."
      );
    }
    return { wallet: this.wallet, account: this.account };
  }

  totalChips(): Promise<bigint> {
    return this.pub.readContract({
      address: this.cfg.factory, abi: FACTORY_ABI, functionName: "totalChips",
    });
  }

  /** Resolve "#7", "7" or a ticker like "TCHIP" to a chip id. */
  async resolveChip(refRaw: string): Promise<number> {
    const ref = refRaw.trim().replace(/^[#$]/, "");
    if (/^\d+$/.test(ref)) return Number(ref);
    const id = await this.pub.readContract({
      address: this.cfg.factory, abi: FACTORY_ABI,
      functionName: "chipByTicker", args: [toB32(ref.toUpperCase())],
    });
    if (id === 0n) throw new Error(`no chip with ticker "${ref.toUpperCase()}" in the factory`);
    return Number(id);
  }

  async chipState(id: number): Promise<ChipState> {
    const [c, ins, em, bn] = await Promise.all([
      this.pub.readContract({ address: this.cfg.factory, abi: FACTORY_ABI, functionName: "chip", args: [BigInt(id)] }),
      this.pub.readContract({ address: this.cfg.factory, abi: FACTORY_ABI, functionName: "inspect", args: [BigInt(id)] }),
      this.pub.readContract({ address: this.cfg.factory, abi: FACTORY_ABI, functionName: "emission", args: [BigInt(id)] }),
      this.pub.getBlockNumber(),
    ]);
    return {
      id,
      label: b32ToString(c.label),
      ticker: b32ToString(c.ticker),
      minter: c.minter,
      token: c.token,
      pc: ins[0], out: ins[1], halted: ins[2], cycles: ins[3],
      behindBlocks: bn > ins[4] ? bn - ins[4] : 0n,
      reserveLeft: em[1], rewardPerCycle: em[2], cyclesLeft: em[3],
    };
  }

  async tokenSymbol(token: Address): Promise<string> {
    try {
      return await this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" });
    } catch { return "?"; }
  }

  /** One paid cycle: the chip executes, the byte is engraved, the caller earns. */
  async tick(id: number, inPort: number) {
    const { wallet, account } = this.requireWallet();
    const byte = inPort & 0xff;
    // simulate first: a revert (someone else's tick this block, or a halted
    // chip) should come back as words, not as burned gas
    const { request } = await this.pub.simulateContract({
      account, address: this.cfg.factory, abi: FACTORY_ABI,
      functionName: "tick", args: [BigInt(id), byte],
    });
    const hash = await wallet.writeContract(request);
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`tick reverted on-chain (block ${receipt.blockNumber}) — likely another sponsor took the cycle`);
    const [ev] = parseEventLogs({ abi: FACTORY_ABI, eventName: "Cycle", logs: receipt.logs });
    return {
      hash, block: receipt.blockNumber,
      cycle: ev?.args.cycle, pc: ev?.args.pc, out: ev?.args.out, halted: ev?.args.halted,
      gasSpent: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
    };
  }

  /** Mint a chip (echo program) and, with targetCycles > 0, launch its token. */
  async mint(p: {
    name: string; ticker: string; logoURI?: string;
    liquidityBps?: number; targetCycles?: number; rom?: bigint[];
  }) {
    const { wallet, account } = this.requireWallet();
    const rom = p.rom ?? ECHO_ROM;
    if (rom.length !== 128) throw new Error("ROM must be exactly 128 slots");
    const price = await this.pub.readContract({
      address: this.cfg.factory, abi: FACTORY_ABI, functionName: "mintPrice",
    });
    const args = [
      rom as unknown as readonly bigint[],
      toB32(p.name.slice(0, 32)),
      toB32(p.ticker.toUpperCase()),
      p.logoURI ?? "",
      p.liquidityBps ?? 2000,
      BigInt(p.targetCycles ?? 7_776_000), // 90 days at one cycle/second
    ] as const;
    const { request, result } = await this.pub.simulateContract({
      account, address: this.cfg.factory, abi: FACTORY_ABI,
      functionName: "mint", args: args as never, value: price,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error("mint reverted on-chain");
    const [id, token] = result as readonly [bigint, Address];
    return { hash, id: Number(id), token, block: receipt.blockNumber };
  }
}

/** Pretty one-paragraph report of a chip, for the agent to speak. */
export function describeChip(s: ChipState, tokenSymbol: string): string {
  const status = s.halted ? "HALTED" : s.behindBlocks > 600n ? "IDLE" : "RUNNING";
  const leds = s.out.toString(2).padStart(8, "0");
  const reserve = Number(s.reserveLeft / 10n ** 18n).toLocaleString("en-US");
  const reward = (Number(s.rewardPerCycle) / 1e18).toFixed(3);
  return (
    `Chip #${s.id} "${s.label}" ($${s.ticker}) — ${status}. ` +
    `Cycle ${s.cycles}, pc=${s.pc}, output ${s.out} (LEDs ${leds}). ` +
    (s.token !== "0x0000000000000000000000000000000000000000"
      ? `Mining reserve: ${reserve} ${tokenSymbol}, paying ${reward} ${tokenSymbol} per cycle` +
        (s.cyclesLeft > 0n ? ` (${s.cyclesLeft} cycles left).` : " (reserve empty — the clock runs unpaid).")
      : "No token attached.")
  );
}
