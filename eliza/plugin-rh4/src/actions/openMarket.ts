/**
 * OPEN_RH4_MARKET — the agent opens its chip token's market.
 *
 * The second half of a launch: the liquidity slice the mint left in the
 * agent's wallet becomes a Uniswap v3 range order born inside a fee vault
 * (sealed forever). The agent picks the pair (WETH or a tokenised stock)
 * and where the 1% fees go: to itself (creator), to the holders, or all to
 * the reserve. Simulated before signing.
 */
import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { clientFromRuntime, findChipRef } from "../config.js";
import { DEFAULTS } from "../rh4.js";
import { openMarket, QUOTES, type FeeMode } from "../market.js";

/** "open the market for chip #7 vs NVDA, fees to holders" → { chip, pair, feeMode } */
export const parseMarketParams = (text: string): { chip?: string; pair?: string; feeMode: FeeMode } => {
  const chip = findChipRef(text);
  const pairRaw = text.match(/\b(?:vs\.?|against|versus|paired?\s+with|with|in)\s+\$?([A-Za-z]{2,6})\b/i)?.[1]?.toUpperCase();
  const pair = pairRaw && QUOTES[pairRaw] ? pairRaw : pairRaw === "ETH" ? "WETH" : undefined;
  const feeMode: FeeMode = /holder/i.test(text) ? "holders" : /\b(?:100%|all)\s+(?:to\s+)?(?:the\s+)?reserve\b|\breserve\s+only\b/i.test(text) ? "reserve" : "creator";
  return { chip, pair, feeMode };
};

const FEE_WORDS: Record<FeeMode, string> = {
  creator: "half of every 1% trading fee is mine forever, the rest feeds the reserve and buys back RH4",
  holders: "80% of every 1% trading fee goes to whoever holds the token, epoch by epoch, the rest feeds the reserve and buys back RH4",
  reserve: "every 1% trading fee feeds the mining reserve and buys back RH4",
};

export const openMarketAction: Action = {
  name: "OPEN_RH4_MARKET",
  similes: ["OPEN_MARKET", "LIST_CHIP_TOKEN", "ADD_LIQUIDITY", "LAUNCH_MARKET"],
  description:
    "Open the Uniswap market of an RH-4 chip token from the agent's own token " +
    "balance: a single-sided range order sealed forever in a fee vault. Pair " +
    "with WETH (default) or a tokenised stock (NVDA, TSLA, SPY...). Fees go " +
    "to the creator (default), to the holders, or all to the reserve.",
  validate: async (runtime: IAgentRuntime) => Boolean(runtime.getSetting("RH4_PRIVATE_KEY")),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ) => {
    const rh4 = clientFromRuntime(runtime);
    try {
      const { chip, pair, feeMode } = parseMarketParams(message.content?.text ?? "");
      const ref = chip ?? (rh4.cfg.agentChipId !== undefined ? String(rh4.cfg.agentChipId) : undefined);
      if (!ref) {
        const text = "Which chip? Say e.g. \"open the market for chip #7 vs WETH\" (or set RH4_AGENT_CHIP_ID).";
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const chipId = await rh4.resolveChip(ref);
      const r = await openMarket(rh4, { chipId, pair, feeMode });
      const text =
        `Market open. $${r.ticker} trades against ${r.pair} at ${r.pool} — the LP position was born inside the ` +
        `${feeMode} vault, so nobody can ever pull it: ${FEE_WORDS[feeMode]}. ` +
        `${DEFAULTS.site}/chip.html?id=${chipId} · tx ${r.hash}`;
      await callback?.({ text });
      return { success: true, text, data: { chipId, pool: r.pool, vault: r.vault, pair: r.pair, feeMode, tx: r.hash } } satisfies ActionResult;
    } catch (e) {
      const text = `Could not open the market: ${(e as Error).message}`;
      await callback?.({ text });
      return { success: false, text } satisfies ActionResult;
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "open the market for chip #7 vs WETH" } },
      { name: "{{agent}}", content: { text: "Market open. $OWL trades against WETH — the LP is sealed forever in the creator vault: half of every fee is mine, the rest feeds the reserve and buys back RH4.", action: "OPEN_RH4_MARKET" } },
    ],
    [
      { name: "{{user1}}", content: { text: "list $OWL against NVDA, fees to holders" } },
      { name: "{{agent}}", content: { text: "Opening the OWL/NVDA market with the LP in the holders vault…", action: "OPEN_RH4_MARKET" } },
    ],
  ],
};
