/**
 * READ_RH4_CHIP — the agent looks at a processor.
 *
 * Free, no wallet needed: reads chip state (pc, output LEDs, cycles,
 * mining reserve) straight from the verified factory contract.
 */

import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { clientFromRuntime, findChipRef } from "../config.js";
import { describeChip, DEFAULTS } from "../rh4.js";

export const readChipAction: Action = {
  name: "READ_RH4_CHIP",
  similes: ["CHECK_CHIP", "CHIP_STATUS", "INSPECT_CHIP", "READ_PROCESSOR"],
  description:
    "Read the live state of an RH-4 chip on Robinhood Chain: program counter, " +
    "output byte (the LEDs), cycles executed, halted or running, and the mining " +
    "reserve of its token. Reference a chip by id (#3) or ticker ($TCHIP).",

  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ) => {
    const rh4 = clientFromRuntime(runtime);
    try {
      const ref = findChipRef(message.content?.text ?? "") ?? String(rh4.cfg.agentChipId ?? 1);
      const id = await rh4.resolveChip(ref);
      const s = await rh4.chipState(id);
      const sym = s.token !== "0x0000000000000000000000000000000000000000"
        ? await rh4.tokenSymbol(s.token) : "?";
      const text = describeChip(s, sym) + ` Live card: ${DEFAULTS.site}/chip.html?id=${id}`;
      const data = JSON.parse(JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
      await callback?.({ text });
      return { success: true, text, data: { chip: data } } satisfies ActionResult;
    } catch (e) {
      const text = `Couldn't read the chip: ${(e as Error).message}`;
      await callback?.({ text });
      return { success: false, text, error: e as Error } satisfies ActionResult;
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "How is chip #2 doing?" } },
      { name: "{{agent}}", content: { text: "Chip #2 \"Test Machine\" ($TCHIP) — RUNNING. Cycle 4021, pc=3, output 42 (LEDs 00101010). Mining reserve: 786,000,000 TCHIP, paying 101.108 TCHIP per cycle.", action: "READ_RH4_CHIP" } },
    ],
    [
      { name: "{{user1}}", content: { text: "check the status of $TCHIP" } },
      { name: "{{agent}}", content: { text: "Reading the factory…", action: "READ_RH4_CHIP" } },
    ],
  ],
};
