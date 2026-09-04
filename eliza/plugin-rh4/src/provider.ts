/**
 * provider.ts — the agent's awareness of its own chip.
 *
 * If RH4_AGENT_CHIP_ID is set, every context the agent composes carries a
 * one-line snapshot of its processor: cycle, output, reserve. The agent
 * doesn't have to ask — it simply *knows* how its machine is doing, the
 * way you know whether your own heart is beating.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { clientFromRuntime } from "./config.js";
import { describeChip } from "./rh4.js";

export const chipStateProvider: Provider = {
  name: "RH4_CHIP_STATE",
  description: "Live state of the agent's own RH-4 processor on Robinhood Chain",
  dynamic: true,

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const rh4 = clientFromRuntime(runtime);
    if (!rh4.cfg.agentChipId) return {};
    try {
      const s = await rh4.chipState(rh4.cfg.agentChipId);
      const sym = s.token !== "0x0000000000000000000000000000000000000000"
        ? await rh4.tokenSymbol(s.token) : "?";
      return { text: `[Your RH-4 processor] ${describeChip(s, sym)}` };
    } catch {
      return {}; // an RPC hiccup should never break the agent's turn
    }
  },
};
