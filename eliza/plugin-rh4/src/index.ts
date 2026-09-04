/**
 * @rh4cpu/plugin-rh4 — RH-4 chips for ElizaOS agents.
 *
 * Gives an agent hands on the RH-4 chip factory on Robinhood Chain:
 * mint a real 8-bit processor (plus its fixed-supply token), power it one
 * cycle at a time — engraving a byte per cycle, a tamper-proof logbook —
 * and read any chip's live state.
 *
 * Factory, vaults and mechanics: https://rh4cpu.tech · docs in
 * INTEGRATION.md at https://github.com/giupy997/chipc
 */

import type { Plugin } from "@elizaos/core";
import { readChipAction } from "./actions/readChip.js";
import { tickChipAction } from "./actions/tickChip.js";
import { mintChipAction } from "./actions/mintChip.js";
import { chipStateProvider } from "./provider.js";

export { Rh4Client, DEFAULTS, ECHO_ROM, describeChip } from "./rh4.js";
export { readChipAction, tickChipAction, mintChipAction, chipStateProvider };

export const rh4Plugin: Plugin = {
  name: "rh4",
  description:
    "Own, power and read RH-4 chips — real gate-level 8-bit processors " +
    "running on Robinhood Chain, each with its own fixed-supply token " +
    "mined one clock cycle at a time.",
  actions: [readChipAction, tickChipAction, mintChipAction],
  providers: [chipStateProvider],
  evaluators: [],
};

export default rh4Plugin;
