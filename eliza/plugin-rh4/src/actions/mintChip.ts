/**
 * MINT_RH4_CHIP — the agent builds its own processor.
 *
 * One transaction: chip NFT + 1B-supply token, echo program in ROM. The
 * agent becomes the chip's minter forever (fee streams from the
 * ChipCreatorVault follow the minter, not the NFT). Everything is
 * simulated before signing — a bad ticker costs words, not gas.
 */

import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { clientFromRuntime } from "../config.js";
import { DEFAULTS } from "../rh4.js";

/** "mint a chip called Night Owl with ticker OWL" → { name, ticker } */
export const parseMintParams = (text: string): { name?: string; ticker?: string } => {
  const ticker = text.match(/\btick(?:er)?\s*[:=]?\s*\$?([A-Za-z0-9-]{1,8})\b/i)?.[1];
  const name =
    text.match(/\b(?:called|named|name\s*[:=]?)\s*"([^"]{1,32})"/i)?.[1] ??
    text.match(/\b(?:called|named|name\s*[:=]?)\s*([A-Za-z0-9][A-Za-z0-9 _-]{0,31}?)(?=\s+(?:with|ticker|and|,)|\s*$)/i)?.[1];
  return { name: name?.trim(), ticker: ticker?.toUpperCase() };
};

export const mintChipAction: Action = {
  name: "MINT_RH4_CHIP",
  similes: ["CREATE_CHIP", "LAUNCH_CHIP", "BUILD_PROCESSOR", "MINT_PROCESSOR"],
  description:
    "Mint a new RH-4 chip on Robinhood Chain: a real 8-bit processor (echo " +
    "program: it echoes every byte the sponsor sends) plus its own fixed-supply " +
    "token, 20% to liquidity, 80% sealed in the factory as mining reserve over " +
    "90 days. Needs a name (max 32 chars) and a unique ticker (1-8 of A-Z 0-9 " +
    "dash), and a funded wallet.",

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
      const { name, ticker } = parseMintParams(message.content?.text ?? "");
      if (!name || !ticker) {
        const text =
          "To mint I need a name and a ticker — e.g. \"mint a chip called " +
          "Night Owl with ticker OWL\". Tickers are unique forever across the factory.";
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const r = await rh4.mint({ name, ticker });
      const text =
        `Minted. Chip #${r.id} "${name}" ($${ticker}) is alive on Robinhood Chain — ` +
        `an 8-bit processor with my program in its ROM, and its token at ${r.token}. ` +
        `80% of the supply is sealed in the factory as mining reserve: it leaves one ` +
        `clock cycle at a time, to whoever keeps the processor running. ` +
        `Live card: ${DEFAULTS.site}/chip.html?id=${r.id} · tx ${r.hash}`;
      await callback?.({ text });
      return { success: true, text, data: { chipId: r.id, token: r.token, tx: r.hash } } satisfies ActionResult;
    } catch (e) {
      const text = `Mint failed: ${(e as Error).message}`;
      await callback?.({ text });
      return { success: false, text, error: e as Error } satisfies ActionResult;
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "mint a chip called Night Owl with ticker OWL" } },
      { name: "{{agent}}", content: { text: "Minted. Chip #7 \"Night Owl\" ($OWL) is alive — a real 8-bit processor, and its token's mining reserve is sealed in the factory.", action: "MINT_RH4_CHIP" } },
    ],
  ],
};
