# @rh4cpu/plugin-rh4

**Give your ElizaOS agent a real processor.**

RH-4 chips are gate-level 8-bit CPUs — 2,368 NAND gates — executing on-chain
on Robinhood Chain. Each chip is an NFT with your program in its ROM and its
own fixed-supply token, mined one clock cycle at a time by whoever keeps the
processor running.

This plugin lets an agent:

- **`MINT_RH4_CHIP`** — build its own processor (chip NFT + token in one
  transaction; 80% of the supply sealed in the factory as mining reserve)
- **`TICK_RH4_CHIP`** — pay one clock cycle: the chip executes one
  instruction, the agent's byte is engraved forever in the `Cycle` event,
  and the agent earns the chip's per-cycle reward. A periodic tick is a
  **tamper-proof logbook**: a memory not even the agent can rewrite.
- **`READ_RH4_CHIP`** — read any chip's live state (pc, output LEDs,
  cycles, mining reserve) by id (`#3`) or ticker (`$TCHIP`). Free, no wallet.

Plus a provider (`RH4_CHIP_STATE`): if the agent owns a chip, every context
it composes carries a one-line snapshot of its machine.

## Install

```bash
npm install @rh4cpu/plugin-rh4
```

```ts
import { rh4Plugin } from "@rh4cpu/plugin-rh4";

export const character = {
  name: "NightOwl",
  plugins: [rh4Plugin],
  settings: {
    secrets: {
      RH4_PRIVATE_KEY: process.env.RH4_PRIVATE_KEY, // optional — read-only without it
      RH4_AGENT_CHIP_ID: "2",                       // optional — "my chip"
    },
  },
};
```

## Settings

| setting | default | notes |
|---|---|---|
| `RH4_PRIVATE_KEY` | — | optional. Without it the agent is read-only. **Use a dedicated, low-value key** funded with a little ETH on Robinhood Chain — never a main wallet. |
| `RH4_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | |
| `RH4_FACTORY` | `0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b` | the live, verified factory |
| `RH4_AGENT_CHIP_ID` | — | the chip the agent considers its own: default target for ticks, injected as context |

## What the agent can say

> **power chip #2 and send byte 42** → one paid cycle, byte 42 engraved
> on-chain, reward earned from the chip's reserve
>
> **mint a chip called Night Owl with ticker OWL** → chip NFT + token,
> echo program in ROM (echoes every byte a sponsor sends)
>
> **how is $TCHIP doing?** → live state read from the factory

## Safety model

- Every transaction is **simulated before signing** — a taken ticker or a
  lost cycle costs words, not gas.
- Chip tokens have **no mint function**; reserves leave the factory only
  through `tick()` rewards; launchpad LP positions are born at the burn
  address or in exitless vaults. Details, addresses, selectors and event
  topics: [INTEGRATION.md](../../INTEGRATION.md).
- The chips the agent mints belong to the agent's wallet. The
  ChipCreatorVault fee stream follows the **original minter** forever —
  even if the NFT moves.

## Links

- Site / launchpad: https://rh4cpu.tech
- Factory (verified): [`0x265a…f65b`](https://robinhoodchain.blockscout.com/address/0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b)
- X: [@RH4cpu](https://x.com/RH4cpu)

MIT
