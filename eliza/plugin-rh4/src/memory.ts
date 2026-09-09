/**
 * memory.ts — RH-4 memory cards: memory that lives inside the chain.
 *
 * A card is an NFT with a capacity. On-chain cards keep their bytes in the
 * contract's storage: the owner writes at an offset, anyone reads. A card
 * can be sealed forever. An agent with a card has a memory that survives
 * any server, and that anyone can audit.
 */
import { stringToHex, hexToString, hexToBytes, bytesToHex, type Address, type Hex } from "viem";
import { DEFAULTS, type Rh4Client } from "./rh4.js";

export const MEMORY_ABI = [
  { type: "function", name: "kinds", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ name: "capacity", type: "uint32" }, { name: "onchain", type: "bool" }, { name: "enabled", type: "bool" }, { name: "price", type: "uint256" }, { name: "name", type: "string" }] },
  { type: "function", name: "kindCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalCards", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "card", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "kind", type: "uint16" }, { name: "locked", type: "bool" }, { name: "used", type: "uint32" },
      { name: "born", type: "uint64" }, { name: "writes", type: "uint32" }, { name: "label", type: "bytes32" } ] }] },
  { type: "function", name: "read", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bytes" }] },
  { type: "function", name: "readAll", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "write", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "seal", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "event", name: "CardMinted", inputs: [
    { name: "id", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true },
    { name: "kind", type: "uint256", indexed: true }, { name: "label", type: "bytes32", indexed: false }, { name: "paid", type: "uint256", indexed: false } ] },
] as const;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export interface KindInfo { kind: number; name: string; capacity: number; onchain: boolean; enabled: boolean; price: bigint }

/** Every card size on sale. */
export async function listKinds(rh4: Rh4Client): Promise<KindInfo[]> {
  const mem = memoryAddress(rh4);
  const n = Number(await rh4.pub.readContract({ address: mem, abi: MEMORY_ABI, functionName: "kindCount" }));
  const out: KindInfo[] = [];
  for (let i = 0; i < n; i++) {
    const k = await rh4.pub.readContract({ address: mem, abi: MEMORY_ABI, functionName: "kinds", args: [BigInt(i)] });
    out.push({ kind: i, name: k[4], capacity: k[0], onchain: k[1], enabled: k[2], price: k[3] });
  }
  return out;
}

/** "4K", "64k", "32M" → the kind with that name (case-insensitive). */
export async function kindByName(rh4: Rh4Client, name: string): Promise<KindInfo | undefined> {
  const kinds = await listKinds(rh4);
  const want = name.toUpperCase().replace(/B$/, "");
  return kinds.find((k) => k.name.toUpperCase() === want);
}

export interface CardInfo { id: number; kind: number; kindName: string; capacity: number; onchain: boolean; locked: boolean; used: number; writes: number; label: string; owner: Address }

function memoryAddress(rh4: Rh4Client): Address {
  const a = rh4.cfg.memory || DEFAULTS.memory;
  if (!a || /^0x0{40}$/.test(a)) throw new Error("memory cards are not deployed yet (set RH4_MEMORY)");
  return a;
}

export async function cardInfo(rh4: Rh4Client, id: number): Promise<CardInfo> {
  const mem = memoryAddress(rh4);
  const [c, owner] = await Promise.all([
    rh4.pub.readContract({ address: mem, abi: MEMORY_ABI, functionName: "card", args: [BigInt(id)] }),
    rh4.pub.readContract({ address: mem, abi: MEMORY_ABI, functionName: "ownerOf", args: [BigInt(id)] }),
  ]);
  const k = await rh4.pub.readContract({ address: mem, abi: MEMORY_ABI, functionName: "kinds", args: [BigInt(c.kind)] });
  return { id, kind: c.kind, kindName: k[4], capacity: k[0], onchain: k[1], locked: c.locked, used: c.used, writes: c.writes,
    label: hexToString(c.label as Hex, { size: 32 }).replace(/\0+$/, ""), owner };
}

/** The bytes written so far, as text (invalid UTF-8 shows as replacement characters). */
export async function readCard(rh4: Rh4Client, id: number): Promise<{ text: string; bytes: number }> {
  const mem = memoryAddress(rh4);
  const raw = await rh4.pub.readContract({ address: mem, abi: MEMORY_ABI, functionName: "readAll", args: [BigInt(id)] });
  const text = new TextDecoder("utf-8", { fatal: false }).decode(hexToBytes(raw as Hex));
  return { text, bytes: ((raw as string).length - 2) / 2 };
}

/** Buy a card, paying RH4 (approve first if needed). The RH4 goes to the mother's factory. */
export async function mintCard(rh4: Rh4Client, kind: number, label: string) {
  const mem = memoryAddress(rh4);
  const { wallet, account } = rh4.requireWallet();
  const k = await rh4.pub.readContract({ address: mem, abi: MEMORY_ABI, functionName: "kinds", args: [BigInt(kind)] });
  if (!k[2]) throw new Error(`card size ${k[4]} is not on sale`);
  const price = k[3];
  const rh4Token = rh4.cfg.token ?? DEFAULTS.token;
  const bal = await rh4.pub.readContract({ address: rh4Token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  if (bal < price) throw new Error(`a ${k[4]} card costs ${price / 10n ** 18n} RH4, this wallet holds ${bal / 10n ** 18n}`);
  const allowance = await rh4.pub.readContract({ address: rh4Token, abi: ERC20_ABI, functionName: "allowance", args: [account.address, mem] });
  if (allowance < price) {
    const { request } = await rh4.pub.simulateContract({ account, address: rh4Token, abi: ERC20_ABI, functionName: "approve", args: [mem, price] });
    const h = await wallet.writeContract(request);
    await rh4.pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
  }
  const { request, result } = await rh4.pub.simulateContract({ account, address: mem, abi: MEMORY_ABI, functionName: "mint", args: [BigInt(kind), stringToHex(label.slice(0, 32), { size: 32 })] });
  const hash = await wallet.writeContract(request);
  const receipt = await rh4.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("mint reverted on-chain");
  return { id: Number(result), hash, price, kindName: k[4], capacity: k[0] };
}

/** Write text at an offset (default: append after the last byte used). Owner only, never on a sealed card. */
export async function writeCard(rh4: Rh4Client, id: number, text: string, offset?: number) {
  const mem = memoryAddress(rh4);
  const { wallet, account } = rh4.requireWallet();
  const info = await cardInfo(rh4, id);
  if (!info.onchain) throw new Error(`card #${id} is a pinned card: it holds a content hash, not bytes`);
  if (info.locked) throw new Error(`card #${id} is sealed: nobody writes on it anymore`);
  if (info.owner.toLowerCase() !== account.address.toLowerCase()) throw new Error(`card #${id} belongs to ${info.owner}, not to this wallet`);
  const data = new TextEncoder().encode(text);
  const at = offset ?? info.used;
  if (at + data.length > info.capacity) throw new Error(`does not fit: ${data.length} bytes at ${at} on a ${info.kindName} card (${info.capacity} bytes, ${info.used} used)`);
  const { request } = await rh4.pub.simulateContract({ account, address: mem, abi: MEMORY_ABI, functionName: "write", args: [BigInt(id), BigInt(at), bytesToHex(data)] });
  const hash = await wallet.writeContract(request);
  const receipt = await rh4.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("write reverted on-chain");
  return { hash, offset: at, bytes: data.length, gas: receipt.gasUsed };
}

export async function sealCard(rh4: Rh4Client, id: number) {
  const mem = memoryAddress(rh4);
  const { wallet, account } = rh4.requireWallet();
  const { request } = await rh4.pub.simulateContract({ account, address: mem, abi: MEMORY_ABI, functionName: "seal", args: [BigInt(id)] });
  const hash = await wallet.writeContract(request);
  const receipt = await rh4.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("seal reverted on-chain");
  return { hash };
}
