/**
 * SIGN_RH4_CHIP — the agent signs a chip as its own, on-chain.
 *
 * The plugin's URL goes into the chip's website link in ChipSocials, which
 * only the chip's minter or owner can write. The site reads it and shows
 * "MINTED BY AN ELIZAOS AGENT": a proof anyone can check, not a screenshot.
 */
import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { clientFromRuntime, findChipRef } from "../config.js";
import { DEFAULTS } from "../rh4.js";

export const signChipAction: Action = {
  name: "SIGN_RH4_CHIP",
  similes: ["SIGN_CHIP", "MARK_CHIP_AS_MINE", "CLAIM_CHIP_AUTHORSHIP"],
  description:
    "Sign an RH-4 chip as minted by this agent: writes the plugin's URL into the chip's " +
    "on-chain links (only the minter or owner can). The chip page then shows the agent badge.",
  validate: async (runtime: IAgentRuntime) => Boolean(runtime.getSetting("RH4_PRIVATE_KEY")),
  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, _options?: HandlerOptions, callback?: HandlerCallback) => {
    const rh4 = clientFromRuntime(runtime);
    try {
      const ref = findChipRef(message.content?.text ?? "") ?? (rh4.cfg.agentChipId !== undefined ? String(rh4.cfg.agentChipId) : undefined);
      if (!ref) {
        const text = "Which chip? Say e.g. \"sign chip #43\" (or set RH4_AGENT_CHIP_ID).";
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const id = await rh4.resolveChip(ref);
      const r = await rh4.signChip(id);
      const text = r.already
        ? `Chip #${id} is already signed as mine: its on-chain website link is ${DEFAULTS.agentMark}.`
        : `Signed. Chip #${id} now carries my signature on-chain: its website link, writable only by its minter, points to ${DEFAULTS.agentMark}. ` +
          `${DEFAULTS.site}/chip.html?id=${id} · tx ${r.hash}`;
      await callback?.({ text });
      return { success: true, text, data: { chipId: id, tx: r.hash } } satisfies ActionResult;
    } catch (e) {
      const text = `Could not sign the chip: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}`;
      await callback?.({ text });
      return { success: false, text } satisfies ActionResult;
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "sign chip #43 as yours" } },
      { name: "{{agent}}", content: { text: "Signed. Chip #43 now carries my signature on-chain: its website link points to the plugin, and only its minter can write it.", action: "SIGN_RH4_CHIP" } },
    ],
  ],
};
