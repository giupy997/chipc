# RH-4 — Integration Guide

Technical reference for trading terminals, bots and indexers integrating the
RH-4 chip launchpad on Robinhood Chain.

- Site / launchpad: https://rh4cpu.tech · https://rh4cpu.tech/launchpad.html
- Source: https://github.com/giupy997/chipc
- Contact: [@RH4cpu](https://x.com/RH4cpu)
- AI agents: ElizaOS plugin in [`eliza/plugin-rh4`](eliza/plugin-rh4) —
  lets an agent mint, power and read chips (mint/tick/read actions + a
  chip-state provider)

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
| **ChipBuybackVault 50/50** (LP lock; creator claims half, rest → reserve + RH4 buyback) | `0x48B8CdbF29d65981F9dFbc4176A868AcE28c30Aa` |
| **ChipBuybackVault 100%** (LP lock; all fees → reserve + RH4 buyback) | `0x2F9D010BE1D2b8F304Bb1c0a02fe9277Fcdb3896` |
| ChipCreatorVault (first generation 50/50, quote share buried) | `0xc7d42eefe7Ba99F35E37cE4b8eBEBB3e66691233` |
| ChipFeeVault (first generation 100%, quote share buried) | `0xb5C467bA319a1aCe5baCe0ffd45f6582C3AE491D` |
| ~~ChipBuybackVault v1~~ `0xAbc4…B363`, `0xc126…6e9e` | withdrawn before use (same-tx spot was manipulable); empty, do not use |
| **ChipSocials** (per-chip links: X, website, Telegram) | `0x355A7C6d677944979bf604080698f131E0B72891` |
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

### Socials (ChipSocials `0x355A…2891`)

Per-chip links live on-chain, writable only by the chip's original minter
or its current NFT owner — read them straight from the contract, no API:

```
links(uint256 chipId)                            0x881d8a40  → (string x, string website, string telegram)
setLinks(uint256 id, string, string, string)     0xdeb711de  (minter or owner only)
event LinksSet(uint256 indexed id, address indexed by, string x, string website, string telegram)
  topic0 0x106bd79598695ee8aff46d8bde4bb73db8a9d99cec0dd6b15557d4a956e44a79
```

Every stored link is either empty or `https://…` in printable ASCII with
no quotes, angle brackets, backslashes or spaces (enforced by the
contract), so it is safe to drop into an `href`. Map a token to its chip
with `chipByToken(address)` first.

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

ChipCreatorVault: `FeesSplit(uint256 indexed tokenId, uint256 indexed chipId, address indexed creator, uint256 amount0, uint256 amount1)`
→ `0x92fa015bd17874d5d476b15a7a487c877a1b8b6b44b9e2c0d0a284e7403f41ab`.

## 5. Markets

Chip tokens trade on **Uniswap v3**, always:

- fee tier **10000 (1%)**, tick spacing 200
- quote token: **WETH** or **tokenised NVDA** (more tech stocks planned)
- pool discovery: `V3Factory.getPool(token, quote, 10000)`
- opened as a **single-sided range order** (FDV range ≈ 5 → 50 ETH
  equivalent): only chip tokens in, the buy side is built by buyers.

**LP custody (critical for safety labels):** the position NFT is minted
directly to either

- the **ChipBuybackVault 50/50** `0x48B8…30Aa` (default), or
- the **ChipBuybackVault 100%** `0x2F9D…3896`.

Both vaults have **no withdraw, transfer or burn function**: custody is
equivalent to a burn, with fees still alive. (A handful of early positions
were sent to `0x…dEaD` directly; that option is no longer offered.)

First-generation positions (opened before Sep 4, 2026) live in
ChipCreatorVault `0xc7d4…1233` / ChipFeeVault `0xb5C4…491D`, whose public
`collect` pays the creator directly and forwards the rest to the factory.

**ChipBuybackVault**: same exitless custody, but the quote share buys RH4
for the mother chip instead of being buried. `collect(tokenId)` (`0xce3f865f`) is permissionless and does
**no swaps**: the creator share accrues (`claimable(creator, token)`
`0xd4570c1c`, withdrawn with `claim(address)` `0x1e83409a` / `claimMany(address[])`
`0x7e686e01`), the chip token goes to the factory reserve, WETH becomes ETH held
in the vault, other quotes wait in `pending(token)` (`0x5eebea20`). Swaps are
executor-only (the project keeper, appointed by the factory owner via
`setExecutor` `0x1c3c0ea8`) with a `minOut` fixed off-chain — a same-block spot
would be manipulable — via `convert(token, amountIn, minOut, fee)` (`0x1bfdd9f9`)
and `buyback(amountIn, minOut)` (`0x460ddf8d`); the executor cannot extract
anything: RH4 only ever lands in the factory.

Events (ChipBuybackVault):

| event | topic0 |
|---|---|
| `FeesSplit(uint256 indexed tokenId, uint256 indexed chipId, address indexed creator, uint256 amount0, uint256 amount1)` | `0x92fa015bd17874d5d476b15a7a487c877a1b8b6b44b9e2c0d0a284e7403f41ab` |
| `Accrued(address indexed creator, address indexed token, uint256 amount)` | `0x25963a1429417a86986b3c9b49e532b39cf61128506dbcd415f9f3420b10af30` |
| `Claimed(address indexed creator, address indexed token, uint256 amount)` | `0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683` |
| `QuotePending(address indexed token, uint256 amount, uint256 total)` | `0x1c439a20fdeb406aa4d7d2641197446461c76626f8c86c4b3dc7981c700cffe2` |
| `Converted(address indexed token, uint256 amountIn, uint256 ethOut)` | `0xe6a45eea08a42f7c3f90f290e8ecf15e16174981943adf509fc9ea49808a64c6` |
| `Buyback(uint256 ethIn, uint256 rh4Out, address indexed by)` | `0x19dce436477c8ec377992306a402bd2728800a3be453520cd9bcf8ef12946325` |
| `ExecutorSet(address indexed executor)` | `0x3e3c5e6d5b512eaa5d5a80669846cfbaf8bde70fc6f7a3be9828cffc9ba5f1db` |

Either way, **the minter never holds the position**. Rug-by-LP-pull is
impossible by construction for markets opened through the launchpad.

Swaps: the router at `0xCaF6…5cB2` is a **SwapRouter02** — `exactInput`
takes `(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)`
(selector `0xb858183f`, **no deadline field**; the v1 selector `0xc04b8d59`
hits the fallback and reverts). Put the deadline in
`multicall(uint256 deadline, bytes[] data)` (`0x5ae401dc`). Buying with native
ETH: `msg.value` with a path starting at WETH. Selling to native ETH:
`exactInput` with recipient `address(2)` (the router itself), then
`unwrapWETH9(uint256 amountMinimum, address recipient)` (`0x49404b7c`) in the
same multicall. For NVDA-paired chips, route `WETH → (500) → NVDA → (10000) → token`.
Price/history: `slot0` and `Swap` events (each carries `sqrtPriceX96`).

**Mother-token exception:** RH4 itself launched on
[pons](https://www.ponsfamily.com/launchpad/0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B)
and has **graduated into Uniswap v4** (not a v3 pool of ours):
PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, PoolKey
`{currency0: ETH (address 0), currency1: RH4, fee: 0, tickSpacing: 200,
hooks: 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044}` (the hook takes 1% in
`afterSwap`), poolId `0x2f71a0c9…`. Spot: `extsload(keccak256(poolId, 6))`
on the PoolManager. The launchpad's automatic buybacks land there.

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
