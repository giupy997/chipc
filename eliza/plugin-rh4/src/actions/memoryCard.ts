/**
 * Memory cards — the agent's memory that lives inside the chain.
 *
 *   MINT_RH4_CARD   buy a card (paid in RH4, which lands in the mother's reserve)
 *   WRITE_RH4_CARD  write text on a card the agent owns (append by default)
 *   READ_RH4_CARD   read what any card holds
 *   SEAL_RH4_CARD   lock a card forever: nobody writes on it again
 *
 * A written card is a memory that survives any server and that anyone can
 * audit byte by byte: the card page on the site reads the same bytes.
 */
import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { clientFromRuntime, findCardRef } from "../config.js";
import { DEFAULTS } from "../rh4.js";
import { cardInfo, kindByName, listKinds, mintCard, readCard, sealCard, writeCard } from "../memory.js";

const fail = (e: unknown) => (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
const cardUrl = (id: number) => `${DEFAULTS.site}/memory.html?id=${id}`;

/** "buy a 64K memory card labeled diary" → { size: "64K", label: "diary" } */
export const parseMintCard = (text: string): { size?: string; label?: string } => {
  const size = text.match(/\b(\d+\s*[KM])B?\b/i)?.[1]?.replace(/\s+/g, "").toUpperCase();
  const label =
    text.match(/\b(?:label(?:l?ed)?|called|named|title[d]?)\s*[:=]?\s*"([^"]{1,32})"/i)?.[1] ??
    text.match(/\b(?:label(?:l?ed)?|called|named|title[d]?)\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9 _.-]{0,31}?)(?=\s+(?:with|and|,)|\s*[.!]?\s*$)/i)?.[1];
  return { size, label: label?.trim() };
};

/** "write "hello" on card #3 at 100" / "write on card #3: hello" → { id, text, offset } */
export const parseWriteCard = (text: string): { id?: number; text?: string; offset?: number } => {
  const id = findCardRef(text);
  const offset = text.match(/\b(?:at|offset)\s*(?:byte\s*)?(\d+)\b/i)?.[1];
  const body =
    text.match(/"([^"]+)"/)?.[1] ??
    text.match(/[“«]([^”»]+)[”»]/)?.[1] ??
    text.match(/\bcard\s*#?\d+\s*[:—-]\s*(.+)$/is)?.[1] ??
    text.match(/\bwrite\s+(?:down\s+)?(.+?)\s+(?:on|to|in)\s+(?:my\s+|the\s+)?card\b/is)?.[1];
  return { id, text: body?.trim(), offset: offset ? Number(offset) : undefined };
};

export const mintCardAction: Action = {
  name: "MINT_RH4_CARD",
  similes: ["BUY_MEMORY_CARD", "MINT_MEMORY_CARD", "GET_MEMORY_CARD", "BUY_RH4_CARD"],
  description:
    "Buy an RH-4 memory card: an NFT with a capacity (4K, 16K, 64K, 256K of bytes stored on-chain; " +
    "32M or 256M as a pinned content hash). Paid in RH4, which goes into the mother chip's mining reserve. " +
    "Say the size and optionally a label, e.g. \"buy a 4K memory card labeled diary\". Needs a funded wallet holding RH4.",
  validate: async (runtime: IAgentRuntime) => Boolean(runtime.getSetting("RH4_PRIVATE_KEY")),
  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, _options?: HandlerOptions, callback?: HandlerCallback) => {
    const rh4 = clientFromRuntime(runtime);
    try {
      const { size, label } = parseMintCard(message.content?.text ?? "");
      const kinds = await listKinds(rh4);
      const onSale = kinds.filter((k) => k.enabled).map((k) => `${k.name} (${k.price / 10n ** 18n} RH4)`).join(", ");
      if (!size) {
        const text = `Which size? On sale: ${onSale}. Say e.g. "buy a 4K memory card labeled diary".`;
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const k = await kindByName(rh4, size);
      if (!k) {
        const text = `No ${size} card. On sale: ${onSale}.`;
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const r = await mintCard(rh4, k.kind, label ?? "");
      const text =
        `Bought. Memory card #${r.id} (${r.kindName}${k.onchain ? `, ${k.capacity} bytes on-chain` : ", pinned content"}` +
        `${label ? `, labeled "${label}"` : ""}) is mine: ${r.price / 10n ** 18n} RH4 went into the mother chip's reserve. ` +
        (k.onchain ? `I can write on it (WRITE_RH4_CARD) and anyone can read it. ` : `It holds a content hash and a name for a web space. `) +
        `${cardUrl(r.id)} · tx ${r.hash}`;
      await callback?.({ text });
      return { success: true, text, data: { cardId: r.id, tx: r.hash } } satisfies ActionResult;
    } catch (e) {
      const text = `Could not buy the card: ${fail(e)}`;
      await callback?.({ text });
      return { success: false, text } satisfies ActionResult;
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "buy a 4K memory card labeled diary" } },
      { name: "{{agent}}", content: { text: "Bought. Memory card #1 (4K, 4096 bytes on-chain, labeled \"diary\") is mine: 2000 RH4 went into the mother chip's reserve.", action: "MINT_RH4_CARD" } },
    ],
  ],
};

export const writeCardAction: Action = {
  name: "WRITE_RH4_CARD",
  similes: ["WRITE_MEMORY_CARD", "SAVE_TO_CARD", "REMEMBER_ON_CHAIN", "WRITE_ON_CARD"],
  description:
    "Write text on an RH-4 memory card this agent owns. The bytes go into the chain's storage " +
    "(appended after what is already there, or at a given offset). Say the card and the text, " +
    "e.g. write \"first note\" on card #1. Uses RH4_AGENT_CARD_ID when no card is named.",
  validate: async (runtime: IAgentRuntime) => Boolean(runtime.getSetting("RH4_PRIVATE_KEY")),
  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, _options?: HandlerOptions, callback?: HandlerCallback) => {
    const rh4 = clientFromRuntime(runtime);
    try {
      const p = parseWriteCard(message.content?.text ?? "");
      const id = p.id ?? rh4.cfg.agentCardId;
      if (id === undefined || !p.text) {
        const text = "Which card, and what? Say e.g. write \"first note\" on card #1 (or set RH4_AGENT_CARD_ID).";
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const r = await writeCard(rh4, id, p.text, p.offset);
      const after = await cardInfo(rh4, id);
      const text =
        `Written. ${r.bytes} bytes at offset ${r.offset} of card #${id}, now ${after.used}/${after.capacity} bytes used, ` +
        `write #${after.writes}. They are in the chain's storage: anyone can read them, only I can change them. ` +
        `${cardUrl(id)} · tx ${r.hash}`;
      await callback?.({ text });
      return { success: true, text, data: { cardId: id, tx: r.hash, offset: r.offset, bytes: r.bytes } } satisfies ActionResult;
    } catch (e) {
      const text = `Could not write on the card: ${fail(e)}`;
      await callback?.({ text });
      return { success: false, text } satisfies ActionResult;
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "write \"day 1: the factory is quiet\" on card #1" } },
      { name: "{{agent}}", content: { text: "Written. 27 bytes at offset 0 of card #1, now 27/4096 bytes used. They are in the chain's storage: anyone can read them, only I can change them.", action: "WRITE_RH4_CARD" } },
    ],
  ],
};

export const readCardAction: Action = {
  name: "READ_RH4_CARD",
  similes: ["READ_MEMORY_CARD", "SHOW_CARD", "WHAT_IS_ON_CARD", "RECALL_FROM_CARD"],
  description:
    "Read an RH-4 memory card: size, owner, bytes used, and the text written on it, straight from the chain. " +
    "Say the card, e.g. \"read card #1\". Uses RH4_AGENT_CARD_ID when no card is named.",
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, _options?: HandlerOptions, callback?: HandlerCallback) => {
    const rh4 = clientFromRuntime(runtime);
    try {
      const id = findCardRef(message.content?.text ?? "") ?? rh4.cfg.agentCardId;
      if (id === undefined) {
        const text = "Which card? Say e.g. \"read card #1\".";
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const info = await cardInfo(rh4, id);
      const mine = rh4.address && info.owner.toLowerCase() === rh4.address.toLowerCase();
      let text = `Card #${id} (${info.kindName}${info.label ? `, "${info.label}"` : ""}) belongs to ${mine ? "me" : info.owner}` +
        `${info.locked ? ", sealed forever" : ""}. `;
      if (info.onchain) {
        const { text: body, bytes } = await readCard(rh4, id);
        text += `${bytes}/${info.capacity} bytes used over ${info.writes} writes.` + (bytes ? `\n\n${body.slice(0, 1500)}${body.length > 1500 ? "…" : ""}` : " It is blank.");
      } else {
        text += `A pinned card: it holds a content hash for a web space.`;
      }
      text += `\n${cardUrl(id)}`;
      await callback?.({ text });
      return { success: true, text, data: { cardId: id, ...info } } satisfies ActionResult;
    } catch (e) {
      const text = `Could not read the card: ${fail(e)}`;
      await callback?.({ text });
      return { success: false, text } satisfies ActionResult;
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "read card #1" } },
      { name: "{{agent}}", content: { text: "Card #1 (4K, \"diary\") belongs to me. 27/4096 bytes used over 1 write.\n\nday 1: the factory is quiet", action: "READ_RH4_CARD" } },
    ],
  ],
};

export const sealCardAction: Action = {
  name: "SEAL_RH4_CARD",
  similes: ["LOCK_MEMORY_CARD", "SEAL_MEMORY_CARD", "FREEZE_CARD"],
  description:
    "Seal an RH-4 memory card this agent owns: its bytes are locked forever, nobody (not even the owner) writes on it again. Say e.g. \"seal card #1\".",
  validate: async (runtime: IAgentRuntime) => Boolean(runtime.getSetting("RH4_PRIVATE_KEY")),
  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, _options?: HandlerOptions, callback?: HandlerCallback) => {
    const rh4 = clientFromRuntime(runtime);
    try {
      const id = findCardRef(message.content?.text ?? "") ?? rh4.cfg.agentCardId;
      if (id === undefined) {
        const text = "Which card? Say e.g. \"seal card #1\".";
        await callback?.({ text });
        return { success: false, text } satisfies ActionResult;
      }
      const r = await sealCard(rh4, id);
      const text = `Sealed. Card #${id} is read-only forever now: what is on it stays exactly as it is. ${cardUrl(id)} · tx ${r.hash}`;
      await callback?.({ text });
      return { success: true, text, data: { cardId: id, tx: r.hash } } satisfies ActionResult;
    } catch (e) {
      const text = `Could not seal the card: ${fail(e)}`;
      await callback?.({ text });
      return { success: false, text } satisfies ActionResult;
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "seal card #1" } },
      { name: "{{agent}}", content: { text: "Sealed. Card #1 is read-only forever now.", action: "SEAL_RH4_CARD" } },
    ],
  ],
};
