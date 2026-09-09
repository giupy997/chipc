/**
 * TRADE_RH4 — the agent buys and sells, within limits it cannot talk itself out of.
 *
 * Off by default. The operator turns it on with RH4_TRADING=on and sets the
 * cap; nothing in a conversation can raise it, because the numbers come from
 * the runtime settings and the checks run in trade.ts before anything is
 * signed. Only the launchpad's quote tokens are reachable.
 *
 * If the agent owns a memory card, every filled trade is appended to it: a
 * track record written in the chain's storage, not in a database somebody
 * can rewrite later.
 */
import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { formatUnits, parseUnits } from "viem";
import { clientFromRuntime } from "../config.js";
import { asset, expectedOut, policyOf, trade, tradableSymbols, type Asset } from "../trade.js";
import { cardInfo, writeCard } from "../memory.js";

const fail = (e: unknown) => (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
const fmt = (v: bigint, d: number, digits = 6) => {
  const n = Number(formatUnits(v, d));
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toPrecision(Math.min(digits, 6)).replace(/\.?0+$/, "");
};

export interface ParsedTrade { amount?: string; from?: string; to?: string }

/**
 * "buy 0.01 eth of NVDA", "buy NVDA with 0.01 eth", "sell 5 NVDA",
 * "swap 100 USDG for SPY", "trade 0.02 eth into TSLA"
 */
export const parseTrade = (textRaw: string): ParsedTrade => {
  const text = textRaw.trim();
  const SYM = "\\$?[A-Za-z]{2,6}";
  const num = "(\\d+(?:[.,]\\d+)?)";
  let m: RegExpMatchArray | null;

  // swap/trade/convert X SYM for|into|to SYM
  if ((m = text.match(new RegExp(`\\b(?:swap|trade|convert|exchange)\\s+${num}\\s*(${SYM})\\s+(?:for|into|to)\\s+(${SYM})\\b`, "i"))))
    return { amount: m[1], from: m[2], to: m[3] };
  // buy SYM with X SYM
  if ((m = text.match(new RegExp(`\\bbuy\\s+(${SYM})\\s+(?:with|using|for)\\s+${num}\\s*(${SYM})\\b`, "i"))))
    return { amount: m[2], from: m[3], to: m[1] };
  // buy X SYM of SYM  ("buy 0.01 eth of NVDA")
  if ((m = text.match(new RegExp(`\\bbuy\\s+${num}\\s*(${SYM})\\s+(?:of|in|worth of)\\s+(${SYM})\\b`, "i"))))
    return { amount: m[1], from: m[2], to: m[3] };
  // sell X SYM (for SYM)
  if ((m = text.match(new RegExp(`\\bsell\\s+${num}\\s*(${SYM})(?:\\s+(?:for|into|to)\\s+(${SYM}))?\\b`, "i"))))
    return { amount: m[1], from: m[2], to: m[3] || "ETH" };
  // buy X SYM  ("buy 0.01 eth of" missing: assume paying in ether)
  if ((m = text.match(new RegExp(`\\bbuy\\s+${num}\\s*(${SYM})\\b`, "i"))))
    return { amount: m[1], from: "ETH", to: m[2] };
  return {};
};

/** A line for the agent's memory card: short, sortable, honest. */
const journalLine = (r: { from: Asset; to: Asset; amountIn: bigint; received: bigint; hash: string }) =>
  `${new Date().toISOString().slice(0, 16).replace("T", " ")} ` +
  `${fmt(r.amountIn, r.from.decimals)} ${r.from.sym} -> ${fmt(r.received, r.to.decimals)} ${r.to.sym} ${r.hash.slice(0, 10)}\n`;

export const tradeAction: Action = {
  name: "TRADE_RH4",
  similes: ["SWAP_TOKENS", "BUY_TOKEN", "SELL_TOKEN", "TRADE_STOCK", "SWAP_RH4"],
  description:
    "Swap between ether and the tokenized stocks the RH-4 launchpad quotes (NVDA, SPY, TSLA, AAPL, USDG and the rest), " +
    "from the agent's own wallet, on Uniswap v3. Say the size and the pair, e.g. \"buy 0.01 eth of NVDA\" or \"sell 5 NVDA\". " +
    "Disabled unless the operator turned trading on, and every trade is capped and slippage-checked. " +
    "RH4 itself cannot be traded here: it has no Uniswap pool, it lives on pons.",

  validate: async (runtime: IAgentRuntime) => {
    if (!runtime.getSetting("RH4_PRIVATE_KEY")) return false;
    const flag = String(runtime.getSetting("RH4_TRADING") ?? "").toLowerCase();
    return ["on", "true", "1", "yes"].includes(flag);
  },

  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, _options?: HandlerOptions, callback?: HandlerCallback) => {
    const rh4 = clientFromRuntime(runtime);
    const policy = policyOf(rh4.cfg);
    try {
      const p = parseTrade(message.content?.text ?? "");
      if (!p.amount || !p.from || !p.to) {
        const text =
          `Say it as a size and a pair: "buy 0.01 eth of NVDA", "sell 5 NVDA", "swap 100 USDG for SPY". ` +
          `I can reach: ${tradableSymbols().join(", ")}.`;
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const from = asset(p.from), to = asset(p.to);
      if (!from || !to) {
        const bad = !from ? p.from : p.to;
        const text = `${bad.toUpperCase()} is not on my list. I can only touch: ${tradableSymbols().join(", ")}.`;
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const amountIn = parseUnits(p.amount.replace(",", "."), from.decimals);

      // say what is about to happen, then do it
      const pre = await expectedOut(rh4, from, to, amountIn).catch(() => null);
      if (pre) {
        await callback?.({ text: `Pricing ${fmt(amountIn, from.decimals)} ${from.sym} into ${to.sym}: about ${fmt(pre.out, to.decimals)} ${to.sym} at the pool's current price. Sending it with a ${policy.slippageBps / 100}% floor.` });
      }

      const r = await trade(rh4, { from, to, amountIn, policy });

      // the track record, on-chain, if the agent has a card to write it on
      let journal = "";
      if (rh4.cfg.agentCardId !== undefined) {
        try {
          const card = await cardInfo(rh4, rh4.cfg.agentCardId);
          if (card.onchain && !card.locked) {
            const w = await writeCard(rh4, rh4.cfg.agentCardId, journalLine(r));
            journal = ` Written to my memory card #${rh4.cfg.agentCardId} at byte ${w.offset}, where it cannot be edited away.`;
          }
        } catch (e) { journal = ` (could not write the journal: ${fail(e)})`; }
      }

      const slipped = r.expected > 0n ? Number((r.received * 10_000n) / r.expected) / 100 : 100;
      const text =
        `Filled. ${fmt(r.amountIn, r.from.decimals)} ${r.from.sym} for ${fmt(r.received, r.to.decimals)} ${r.to.sym}, ` +
        `about ${r.ethValue.toFixed(4)} ETH of size through ${r.fees.length === 1 ? "one pool" : "two pools"} ` +
        `(${r.fees.map((f) => f / 10_000 + "%").join(", ")} fee). Got ${slipped.toFixed(1)}% of the quoted price. ` +
        `tx ${r.hash}.` + journal;
      await callback?.({ text });
      return { success: true, text, data: { tx: r.hash, from: r.from.sym, to: r.to.sym, amountIn: r.amountIn.toString(), received: r.received.toString() } } satisfies ActionResult;
    } catch (e) {
      const text = `No trade: ${fail(e)}`;
      await callback?.({ text });
      return { success: false, text } satisfies ActionResult;
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "buy 0.01 eth of NVDA" } },
      { name: "{{agent}}", content: { text: "Filled. 0.01 ETH for 0.0031 NVDA through one pool. Written to my memory card, where it cannot be edited away.", action: "TRADE_RH4" } },
    ],
    [
      { name: "{{user1}}", content: { text: "sell 5 NVDA" } },
      { name: "{{agent}}", content: { text: "Filled. 5 NVDA for 0.0161 ETH. tx 0x…", action: "TRADE_RH4" } },
    ],
  ],
};
