/**
 * config.ts — how the plugin reads its settings from the agent runtime.
 *
 * Everything comes from character `settings.secrets` / env:
 *
 *   RH4_PRIVATE_KEY   optional — without it the agent is read-only.
 *                     Use a DEDICATED low-value key for the agent.
 *   RH4_RPC_URL       optional, defaults to the public mainnet RPC
 *   RH4_FACTORY       optional, defaults to the live verified factory
 *   RH4_AGENT_CHIP_ID optional — "the agent's own chip", used as default
 *                     target and injected as context by the provider
 *   RH4_MEMORY        optional — the RH4Memory contract (memory cards);
 *                     defaults to the deployed one once there is one
 *   RH4_AGENT_CARD_ID optional — the memory card the agent writes to by default
 */

import type { IAgentRuntime } from "@elizaos/core";
import { Rh4Client, DEFAULTS } from "./rh4.js";
import type { Address, Hex } from "viem";

let cached: Rh4Client | null = null;
let cachedKey = "";

export function clientFromRuntime(runtime: IAgentRuntime): Rh4Client {
  const rpc = (runtime.getSetting("RH4_RPC_URL") as string) || DEFAULTS.rpc;
  const factory = ((runtime.getSetting("RH4_FACTORY") as string) || DEFAULTS.factory) as Address;
  const pkRaw = (runtime.getSetting("RH4_PRIVATE_KEY") as string) || "";
  const privateKey = pkRaw ? ((pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as Hex) : undefined;
  const chipRaw = runtime.getSetting("RH4_AGENT_CHIP_ID") as string;
  const agentChipId = chipRaw ? Number(chipRaw) : undefined;
  const memory = ((runtime.getSetting("RH4_MEMORY") as string) || DEFAULTS.memory || undefined) as Address | undefined;
  const cardRaw = runtime.getSetting("RH4_AGENT_CARD_ID") as string;
  const agentCardId = cardRaw ? Number(cardRaw) : undefined;

  const key = `${rpc}|${factory}|${privateKey ? "w" : "r"}|${agentChipId ?? ""}|${memory ?? ""}|${agentCardId ?? ""}`;
  if (!cached || cachedKey !== key) {
    cached = new Rh4Client({ rpc, factory, privateKey, agentChipId, memory, agentCardId });
    cachedKey = key;
  }
  return cached;
}

/** Find a chip reference in free text: "#7", "chip 7" or "$TCHIP". */
export function findChipRef(text: string): string | undefined {
  const byId = text.match(/(?:#|\bchip\s+#?)(\d+)\b/i)?.[1];
  if (byId) return byId;
  const byTicker = text.match(/\$([A-Za-z0-9-]{1,12})\b/)?.[1];
  return byTicker;
}

/** Find a memory card reference in free text: "card #3" or "card 3". */
export function findCardRef(text: string): number | undefined {
  const m = text.match(/\bcard\s*#?(\d+)\b/i)?.[1];
  return m ? Number(m) : undefined;
}
