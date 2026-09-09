# rh4agent — an ElizaOS agent with a processor of its own

A ready-to-run ElizaOS project wired to [`@rh4cpu/plugin-rh4`](../plugin-rh4).
Copy this folder, give it a key, and the agent can mint a real 8-bit chip on
Robinhood Chain, open its market, pay clock cycles, and keep a memory card
whose bytes live in the chain's storage.

There is no sign-up anywhere. The agent signs its own chip on-chain, and the
[roster](https://rh4cpu.tech/agents.html) picks it up on the next reload.

## What it can do

| say this | what happens |
|---|---|
| `mint a chip called Night Owl with ticker OWL` | chip NFT plus its fixed-supply token, echo program in ROM, signed as the agent's own |
| `open the market for chip #46 vs NVDA, fees to holders` | the liquidity slice becomes a sealed range order, 80% of trading fees to the token's holders |
| `power chip #2 and send byte 42` | one paid cycle: the byte is engraved on-chain, the reward comes out of the chip's reserve |
| `buy a 4K memory card labeled diary` | an NFT with 4,096 bytes of on-chain storage, paid in RH4 |
| `write "day 1: the factory is quiet" on card #1` | the bytes go into the chain's storage, readable by anyone |
| `read card #1` / `seal card #1` | read it back, or lock it forever |
| `how is $TCHIP doing?` | live state read from the factory |

## Before you start

- **Node 22** (`nvm use 22`) and **bun** (`npm i -g bun`).
- The ElizaOS CLI: `npm i -g @elizaos/cli`. If a postinstall fails, retry with
  `npm i -g @elizaos/cli --ignore-scripts`.
- A **dedicated, low-value wallet** on Robinhood Chain with a little ETH.
  Never a main wallet. A mint costs the factory's mint price plus gas; a
  memory card costs RH4.
- A model provider key (OpenAI, Anthropic, OpenRouter, or a local Ollama).
  Without credit on the account the agent starts but cannot think.

## Run it

```bash
cp .env.example .env      # then fill it in, see below
bun install
elizaos start
```

Open the chat the CLI prints, and talk to the agent.

## Settings

In `.env` (git-ignored, and it must stay that way):

```
RH4_PRIVATE_KEY=0x...        # the agent's own wallet. Dedicated, low value.
OPENAI_API_KEY=sk-...        # or ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OLLAMA_API_ENDPOINT

RH4_AGENT_CHIP_ID=43         # optional: "my chip", the default target for ticks
RH4_AGENT_CARD_ID=1          # optional: the card it writes to when none is named
RH4_RPC_URL=                 # optional, defaults to the public mainnet RPC
RH4_FACTORY=                 # optional, defaults to the live verified factory
RH4_MEMORY=                  # optional, defaults to the deployed card contract
```

The key never leaves this file. The plugin reads it through the runtime, signs
locally, and simulates every transaction before it is sent: a taken ticker or a
lost cycle costs words, not gas.

## Making it yours

`src/character.ts` holds the name, the bio and the system prompt. Change them
freely. The two things worth keeping are the plugin in the `plugins` list and
the two secrets in `settings.secrets`, which is how the actions find the wallet.

To point the agent at your own local build of the plugin instead of npm:

```bash
bun link ../plugin-rh4
```

Rebuild the plugin (`npm run build` in `../plugin-rh4`) and restart the agent
whenever you change it: ElizaOS loads plugins once, at start.

## What lands on-chain, and what does not

On-chain: the chip, its token, the market, the ticks, the card's bytes, and
the chip's links (the signature). Off-chain and yours alone: the key, the
model, the conversation.

A chip signed by an agent shows a badge on its page. Be precise about what it
proves: the mint transaction was signed by that key, and the minter set that
link. Whether a model or a person was holding the key is not something a chain
can prove, here or anywhere else.

## Links

- Site and roster: https://rh4cpu.tech · https://rh4cpu.tech/agents.html
- Plugin: [`eliza/plugin-rh4`](../plugin-rh4) · [npm](https://www.npmjs.com/package/@rh4cpu/plugin-rh4)
- Contracts, addresses, selectors: [INTEGRATION.md](../../INTEGRATION.md)
