/**
 * TICK_RH4_CHIP — the agent powers a processor for one cycle.
 *
 * tick() is permissionless: the agent pays the gas, the chip executes one
 * instruction, and the agent earns that chip's reward from the mining
 * reserve. The byte it sends is engraved forever in the Cycle event —
 * which makes a periodic tick a tamper-proof logbook for the agent.
 */

import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { clientFromRuntime, findChipRef } from "../config.js";

const findByte = (text: string): number | undefined => {
  const m = text.match(/\b(?:byte|input|send(?:ing)?)\s*[:=]?\s*(\d{1,3})\b/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n <= 255 ? n : undefined;
};

export const tickChipAction: Action = {
  name: "TICK_RH4_CHIP",
  similes: ["POWER_CHIP", "TICK_CHIP", "MINE_CHIP", "FEED_CHIP", "SPONSOR_CYCLE"],
  description:
    "Pay one clock cycle of an RH-4 chip on Robinhood Chain. The chip executes " +
    "one instruction, the agent's input byte (0-255) is engraved in the Cycle " +
    "event, and the agent earns the chip's per-cycle reward from its mining " +
    "reserve. Needs a funded wallet (RH4_PRIVATE_KEY).",

  validate: async (runtime: IAgentRuntime) => {
    return Boolean(runtime.getSetting("RH4_PRIVATE_KEY"));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ) => {
    const rh4 = clientFromRuntime(runtime);
    try {
      const asked = message.content?.text ?? "";
      const ref = findChipRef(asked) ?? String(rh4.cfg.agentChipId ?? 1);
      const id = await rh4.resolveChip(ref);
      const byte = findByte(asked) ?? 0;
      const r = await rh4.tick(id, byte);
      const leds = Number(r.out ?? 0).toString(2).padStart(8, "0");
      const text =
        `Cycle ${r.cycle} of chip #${id} is mine — engraved byte ${byte} in block ${r.block}. ` +
        `The chip answered: pc=${r.pc}, output ${r.out} (LEDs ${leds})` +
        (r.halted ? " — and hit HLT. The clock stops here." : ".") +
        ` Gas: ${r.gasSpent} ETH. tx ${r.hash}`;
      await callback?.({ text });
      return {
        success: true, text,
        data: { chipId: id, byte, tx: r.hash, cycle: r.cycle?.toString(), out: Number(r.out ?? 0), halted: r.halted },
      } satisfies ActionResult;
    } catch (e) {
      const text = `Tick failed: ${(e as Error).message}`;
      await callback?.({ text });
      return { success: false, text, error: e as Error } satisfies ActionResult;
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "power chip #2 and send byte 42" } },
      { name: "{{agent}}", content: { text: "Cycle 4022 of chip #2 is mine — engraved byte 42. The chip echoed 42 back on its LEDs.", action: "TICK_RH4_CHIP" } },
    ],
    [
      { name: "{{user1}}", content: { text: "tick your chip" } },
      { name: "{{agent}}", content: { text: "Paying one cycle of my processor…", action: "TICK_RH4_CHIP" } },
    ],
  ],
};
