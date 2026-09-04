# RH-4 — Integration Guide

Technical reference for trading terminals, bots and indexers integrating the
RH-4 chip launchpad on Robinhood Chain.

- Site / launchpad: https://rh4cpu.tech · https://rh4cpu.tech/launchpad.html
- Source: https://github.com/giupy997/chipc
- Contact: [@RH4cpu](https://x.com/RH4cpu)

## 1. Chain

| | |
|---|---|
| Network | Robinhood Chain (Arbitrum Orbit) |
| Chain id | `4663` (`0x1237`) |
| RPC | `https://rpc.mainnet.chain.robinhood.com` (supports JSON-RPC batching) |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Block time | ~100–250 ms |

⚠ Orbit quirk: `block.number` returns the **parent chain's** height. The L2
block number comes from the ArbSys precompile (`address(100)`,
`arbBlockNumber()`). Our contracts already handle this internally.

## 2. Core addresses (all verified on Blockscout, exact match)

| contract | address |
|---|---|
| **ChipFactory8** (the launchpad) | `0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b` |
| RH8GateArray (the silicon, `pure`) | `0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a` |
| Chip8Renderer (on-chain NFT SVG) | `0xd6e71a902a927C2d36110d35769ed49bf8705b28` |
| **ChipFeeVault** (LP lock + fee sweep) | `0xb5C467bA319a1aCe5baCe0ffd45f6582C3AE491D` |
| RH4 project token (on pons) | `0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B` |

Uniswap v3 on this chain (canonical addresses are empty stubs — these are the
real ones, recovered and verified):

| contract | address |
|---|---|
| V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| SwapRouter | `0xCaF681a66D020601342297493863e78c959E5cB2` |
| WETH9 | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Tokenised NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |

ABIs: pull from the verified contracts on Blockscout, or from
`out/` after `forge build` in the repo.

## 3. What a chip is

Every chip is an ERC-721 in **ChipFactory8** (one shared collection,
`RH Chip` / `CHIP`) and a real 8-bit processor: 2,368 NAND gates executed
on-chain, 1,024-word ROM, 256 bytes of RAM, one instruction per block via
`tick()`. Minting a chip (usually) also deploys its **ChipToken**.

### ChipToken (one per chip)

- Fixed supply **1,000,000,000 × 1e18**, minted once in the constructor.
- **No mint function exists.** Supply can never grow.
- Split at birth: a liquidity slice (0–60%) to the minter; the remainder
  stays in the factory as the **mining reserve**.
- The reserve leaves the factory **only** through `tick()` rewards. The
  factory's `withdraw()` moves ETH only, never tokens. There is no function
  that can move a reserve anywhere else.
- The mother token (RH4) is the exception: created by pons, adopted by
  chip #1 via `attachToken`. Same custody rules.

### Discovering chips and tokens

```
totalChips()                        0x73514205  → uint256
chip(uint256 id)                    0x8c6aefcf  → Chip struct (see below)
chipByTicker(bytes32)               0x4da5bb73  → chip id (0 = free)
chipByToken(address)                0xb8b4671d  → chip id served by a token
emission(uint256 id)                0x58292a3d  → (token, reserveLeft, rewardPerCycle, cyclesLeft)
inspect(uint256 id)                 0xb3e98ae8  → (pc uint16, out uint8, halted bool, cycles uint256, lastTickBlock uint256)
logo(uint256 id)                    0xa29ba8a7  → string (https:// or ipfs://)
tokenURI(uint256 id)                → base64 JSON, image drawn from live state
```

`Chip` struct fields, in order: `machine (uint256, packed state)`,
`label (bytes32)`, `ticker (bytes32)`, `minter (address)`,
`bornBlock (uint64, L2 height)`, `resets (uint32)`, `token (address)`,
`rewardPerCycle (uint96)`.

## 4. Events to index (ChipFactory8)

| event | topic0 |
|---|---|
| `ChipMinted(uint256 indexed id, address indexed minter, bytes32 indexed ticker, bytes32 label)` | `0xe16ebcd5826e8fad06bc57cf29dbfb38c93766eb6df5320acceb51366f717d37` |
| `TokenLaunched(uint256 indexed id, address indexed token, uint256 toLiquidity, uint256 reserve, uint256 rewardPerCycle)` | `0x37a15ad6422bd0641fc4188d5b385eac92d644ea1a48795b158b196d52423818` |
| `TokenAttached(uint256 indexed id, address indexed token, uint256 reserve, uint256 rewardPerCycle)` | `0x4f72078377d5de9fb5c3a8375446fba1eced15509fb8a572a7cb667dd3c95b00` |
| `Cycle(uint256 indexed id, uint256 indexed cycle, address indexed sponsor, uint16 pc, uint8 inPort, uint8 out, bool halted)` | `0x67953662dc44ae54a3bb5081bd2cdcac5f610e0abbe5d1cdf3a145ce44fa05f0` |
| `Rewarded(uint256 indexed id, address indexed sponsor, uint256 amount)` | `0x6d46424d7308d93179bbc5c8c01e098e8353dad13aff9809fd8a881a69feaa3a` |

**New token listing detection**: index `TokenLaunched` (native launches) and
`TokenAttached` (externally-created tokens adopted by a chip). The token
address is `topics[2]`.

ChipFeeVault: `FeesForwarded(uint256 indexed tokenId, address token0, address token1, uint256 amount0, uint256 amount1)`
→ `0x1c12d9097777aef029f9495dfbeea56113e2561ba2bb70f270e411e1bace8dde`.

## 5. Markets

Chip tokens trade on **Uniswap v3**, always:

- fee tier **10000 (1%)**, tick spacing 200
- quote token: **WETH** or **tokenised NVDA** (more tech stocks planned)
- pool discovery: `V3Factory.getPool(token, quote, 10000)`
- opened as a **single-sided range order** (FDV range ≈ 5 → 50 ETH
  equivalent): only chip tokens in, the buy side is built by buyers.

**LP custody (critical for safety labels):** the position NFT is minted
directly to either

- `0x000000000000000000000000000000000000dEaD` (burned, fees unclaimable), or
- the **ChipFeeVault** `0xb5C4…491D` — no owner, no transfer, no
  `decreaseLiquidity`: liquidity can never be pulled. `collect(tokenId)` is
  public and forwards all accrued fees to the factory, where the chip-token
  side joins the mining reserve.

Either way, **the minter never holds the position**. Rug-by-LP-pull is
impossible by construction for markets opened through the launchpad.

Swaps: standard v3 `SwapRouter.exactInput` at `0xCaF6…5cB2`. For NVDA-paired
chips, route `WETH → (500) → NVDA → (10000) → token`. Price/history: `slot0`
and `Swap` events (each carries `sqrtPriceX96`).

**Mother-token exception:** RH4 itself trades on
[pons](https://www.ponsfamily.com/launchpad/0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B)
(bonding curve until 4.2 ETH raised, then graduation into a locked pool) —
not on a v3 pool of ours.

## 6. Mining (the emission channel)

`tick(uint256 id, uint8 inPort)` — selector `0xe5bbf637` — is permissionless,
one call per chip per L2 block. The caller pays gas (~257k), the chip executes
one instruction, and the caller receives `rewardPerCycle` of that chip's token
from the reserve. Sponsor, byte and output are engraved in the `Cycle` event.

- Reward per cycle is **immutable** per chip (no setter exists).
- Reserve = the factory's balance of that chip's token; anyone can top it up
  (transfers extend duration, never rate).
- When the reserve is empty the clock keeps running, unpaid.

## 7. Safety summary (for token labels)

| vector | status |
|---|---|
| Mint / inflate supply | impossible — no mint function in any chip token |
| Pull the reserve | impossible — only exit is `tick()` rewards |
| Pull the LP | impossible — position born at burn address or in the exitless vault |
| Change fees / emission | impossible — no setters |
| Honeypot mechanics | none — plain OpenZeppelin ERC-20, no transfer hooks, no taxes |

All source verified on Blockscout (exact match). Factory:
`0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b`.
