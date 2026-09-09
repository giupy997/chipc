# @rh4cpu/plugin-rh4

**Give your ElizaOS agent a real processor.**

RH-4 chips are gate-level 8-bit CPUs — 2,368 NAND gates — executing on-chain
on Robinhood Chain. Each chip is an NFT with your program in its ROM and its
own fixed-supply token, mined one clock cycle at a time by whoever keeps the
processor running.

This plugin lets an agent:

- **`MINT_RH4_CHIP`** — build its own processor (chip NFT + token in one
  transaction; half the supply lands in the agent's wallet for the market,
  half is sealed in the factory as mining reserve over a 12-hour emission)
- **`SIGN_RH4_CHIP`** — sign a chip as agent-minted, on-chain: the plugin's
  URL goes into the chip's website link (ChipSocials, writable by the minter
  or owner only). Minting does it by itself; the site shows
  **MINTED BY AN ELIZAOS AGENT** on the chip's page. Anyone can verify it:
  the chip's minter is the agent's wallet, and that wallet wrote the link.
- **`OPEN_RH4_MARKET`** — open the token's Uniswap v3 market from that
  slice: a single-sided range order born inside a fee vault, sealed forever.
  Pair with WETH or a tokenised stock (NVDA, TSLA, SPY, AAPL…); fees to the
  agent (creator, default), to the holders, or all to the reserve.
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
| `RH4_FACTORY` | `0x4a5E39B8a41c169210d1F7dCD307854330D8144C` | the live, verified factory (ChipFactory9); chips 1–42 are read from the first one |
| `RH4_AGENT_CHIP_ID` | — | the chip the agent considers its own: default target for ticks, injected as context |
| `RH4_MEMORY` | `0xfBacC34038838A0277D3021D90637E8e31a82883` | the memory card contract (empty until deployed) |
| `RH4_AGENT_CARD_ID` | — | the memory card the agent writes to when none is named |

## What the agent can say

> **power chip #2 and send byte 42** → one paid cycle, byte 42 engraved
> on-chain, reward earned from the chip's reserve
>
> **mint a chip called Night Owl with ticker OWL** → chip NFT + token,
> echo program in ROM (echoes every byte a sponsor sends)
>
> **sign chip #43 as yours** → the agent's signature lands in the chip's
> on-chain links (a mint already does this by itself)
>
> **open the market for $OWL vs NVDA, fees to holders** → the liquidity
> slice becomes a sealed range order; 80% of the trading fees go to the
> token's holders
>
> **how is $TCHIP doing?** → live state read from the factory
>
> **buy a 4K memory card labeled diary** → an NFT with 4,096 bytes of
> on-chain storage, paid in RH4 (which lands in the mother chip's reserve)
>
> **write "day 1: the factory is quiet" on card #1** → the bytes go into
> the chain's storage, appended after what is there (or `at 100` for an
> offset); anyone can read them, only the owner can change them
>
> **read card #1** → size, owner, bytes used and the text, straight from
> the chain · **seal card #1** → locked forever, not even the owner writes again

## Safety model

- Every transaction is **simulated before signing** — a taken ticker or a
  lost cycle costs words, not gas.
- Chip tokens have **no mint function**; reserves leave the factory only
  through `tick()` rewards; LP positions are born in exitless vaults (no
  withdraw, no transfer, no burn function): only the 1% fees move. Details,
  addresses, selectors and event topics: [INTEGRATION.md](../../INTEGRATION.md).
- The chips the agent mints belong to the agent's wallet. The
  ChipCreatorVault fee stream follows the **original minter** forever —
  even if the NFT moves.

## Links

- Site / launchpad: https://rh4cpu.tech
- Factory (verified): [`0x265a…f65b`](https://robinhoodchain.blockscout.com/address/0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b)
- X: [@RH4cpu](https://x.com/RH4cpu)

MIT
