# RH-4 — a real processor that lives inside Robinhood Chain

**https://rh4cpu.tech**

A real processor written in Verilog, synthesised down to **nothing but NAND
gates and flip-flops**, executed gate by gate inside a contract on Robinhood
Chain. No emulation: every `tick()` walks all **2,368 NAND gates** of the
current generation, latches its **171 flip-flops**, and touches its
**256 bytes of RAM** — exactly as the silicon would.

The clock is not an oscillator. **One block = one clock edge.** Robinhood
Chain closes a block every ~100 ms, so the processor runs at **~10 Hz** —
when someone pays for it.

## Live on mainnet

Robinhood Chain (chain id 4663), live since 31 August 2026.

| | |
|---|---|
| Site | https://rh4cpu.tech |
| RH4 token | `0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B` |
| Market | [pons](https://www.ponsfamily.com/launchpad/0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B) — bonding curve, locked LP at graduation |
| ChipFactory8 | `0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b` |
| RH8GateArray | `0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a` |
| Chip8Renderer | `0xd6e71a902a927C2d36110d35769ed49bf8705b28` |
| Chip #1, the mother | rh4.cpu (`RH4`) — running `echo8`, forever |

Every chip NFT links back to the site (`external_url` →
`https://rh4cpu.tech/?chip=N`) and chip #1 carries the project logo as its
`image`, both baked into the renderer on-chain.

The token launches on [pons](https://www.ponsfamily.com/launchpad) — the
launchpad where Robinhood Chain trades: bonding curve, graduation at 4.2 ETH
raised, liquidity locked from graduation on. **70% of the supply belongs to
the public. The other 30% — the developer buy — never touches the
developer's pocket**: it is sent whole to the factory
(`0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b`) as the **mining reserve**,
and it leaves one clock cycle at a time — sized for 90 days of full clock.

## Why "4"

The project was born as a 4-bit processor and the name stayed, the way a 911
keeps its number. But the 4 stopped counting bits almost immediately: **it
counts the four independent proofs** every generation of silicon must pass
before it breathes on mainnet —

1. RTL simulation (iverilog)
2. gate-level simulation of the synthesised netlist (`tools/netsim8.js`)
3. the on-chain interpreter, alone (`forge test`)
4. a chip minted from a real factory

— all four required to agree **cycle for cycle**. The bits will grow with
each generation. The proofs stay four.

## The point

**A blockchain cannot replace physical chips — it runs on them.** Every
cycle the RH-8 executes is re-executed by every validator: on-chain compute
is silicon times redundancy, never an alternative to silicon. Anyone
promising to replace GPUs with a chain is selling physics that does not
exist.

What the chain has, and the datacenter never will, is a different property:
**a physical chip cannot prove what it did. This one can.** Every cycle is
public, deterministic, and re-executable by anyone, forever.

The declared road (the "roadmap" section of the site):

1. **R1 — the launchpad opens.** Minting from the browser: write your
   program in the workbench — or pick one — upload a logo, choose the market
   your chip trades against — ETH or tokenised stocks. And the same doors
   open to machines: an MCP server so AI agents can mint, power and read
   chips of their own. Pure software; the factory already accepts every
   mint, whoever — or whatever — sends it. Next for the launchpad: a token
   generation with **holder fee-sharing** built in — trading fees that find
   every holder's wallet.
2. **R2 — the court.** The first protocol upgrade. Processors run off-chain
   at full speed; results post with a bond; a dispute bisects to one cycle
   and replays it inside the deployed gate array. Off-chain speed, on-chain
   truth. The hard primitive of that court — a pure, deterministic `step()`
   that executes exactly one cycle — is not roadmap: it is deployed.
3. **R3 — wider silicon.** RH-16, RH-32, RH-64, more RAM, many cycles per
   transaction. Each generation is new silicon beside the old, never a rug
   under it: same token, four proofs, every time.
4. **R4 — silicon for AI.** A neural network synthesised to NAND, inference
   running gate-level inside the chain, and through the court at real
   speed: the first inference anyone can re-execute, cycle for cycle. Not
   faster answers — answers you can check.

## The 8-bit generation

The first generation ran on its own and that was all — an object, not an
instrument. The RH-8 takes **a byte from whoever calls `tick(id, byte)`**
and has **memory that persists between cycles**.

| | RH-4 | RH-8 |
|---|---|---|
| data width | 4 bit | 8 bit |
| input | — | one byte per tick |
| RAM | — | 256 bytes per chip |
| instruction word | 12 bit | 25 bit |
| opcodes | 16 | 29 |
| NAND gates | 1,029 unrolled in Yul | 2,368 **interpreted** from a table |
| architectural state | 79 bits, one slot | 171 bits, still one slot |
| gas per cycle | ~60k | ~257k |

The netlist is no longer unrolled into code (it would blow past the 24 kB
contract limit): it becomes **data**, and the contract walks it — eight
gates per loop iteration, one exact `MLOAD` each. The same interpreter would
carry a ten-thousand-gate CPU without touching the bytecode ceiling.

Two honest design choices carried over from real hardware:

- **ROM and RAM live in the contract, not in the netlist.** The processor
  asks — it exposes an address, the contract answers. In gates this costs
  zero; 256 bytes as flip-flops would have been two thousand gates more.
- **A `ld` takes two cycles.** The address latches in one cycle, the data
  arrives the next — like the silicon it is.

One Orbit-chain scar worth knowing: on Robinhood Chain `block.number` is the
**parent chain's** block height (~12 s), not the L2 block. The one-tick-per-
block gate reads the real L2 height from the ArbSys precompile — using
`block.number` would have quietly turned a 90-day emission into 29 years.

## Every chip launches its own token — and cycles are the only way to earn it

Minting a chip (an ERC-721 that *is* a processor: its own ROM, RAM and
state) also deploys a `ChipToken`: **fixed supply, one billion, and no
`mint` function anywhere** — no one can print more, not the operator, not
the chip's owner, not the factory.

The supply splits once, at birth:

| | where it goes |
|---|---|
| liquidity slice (up to 60%) | straight to the minter, to open the market |
| everything else | stays in the factory, leaves **one cycle at a time** |

There is no second path. Apart from buying them, **the only way to obtain a
chip's tokens is to keep its processor alive**. The factory's `withdraw()`
moves ETH only — the reserve provably cannot be taken out except through
`tick()`. Which yields the property the whole thing stands on:

> **A chip runs as fast as the market thinks it deserves.**

If the token is worth more than the gas of a tick, someone calls it. If it
is not, the chip stalls — the honest outcome. When the reserve runs dry the
clock does **not** stop: it continues free. The chip's `owner()` view on the
token follows the NFT, so explorers always know who the chip belongs to.

The lifetime cycle counter is **monotonic**: `restart()` reboots the
processor and clears the RAM, but what the chip has ground through history
stays. Otherwise "this chip has executed N cycles" would mean nothing.

## The clock is the scarce thing, not the chip

`tick(id, byte)` is open to anyone — **not the owner, anyone** — once per
block per chip. Whoever pays is engraved in the `Cycle` event as that
cycle's sponsor, and the byte they send is what the program reads with `in`.

```bash
export PRIVATE_KEY=0x…   # never in chat, never in shell history
RH4_FACTORY=0x8429c2c06442c01d916c1286573d0948efcea0ea \
  node tools/keeper.js --chip 1 --input 0 --sweep-to factory --budget 0.01
```

The keeper has no special rights; it is merely the first to pay. It stops on
`--budget` (ETH), `--cycles`, or a `hlt` — and `--sweep-to factory` returns
everything it mined to the reserve on **every** exit path, so running the
clock accumulates nothing.

## Measured, not estimated

| operation | gas | on Robinhood Chain |
|---|---|---|
| deploy the whole stack, once per chain | ~9M | ~0.00024 ETH |
| mint a chip + launch its token | 829,552 | ~0.0000167 ETH |
| one clock cycle (sponsor pays) | 256,740 | ~0.0000052 ETH |

The shared gate array (`pure`, stateless, ownerless — any future factory can
reuse it) costs +1,301 gas per cycle over a standalone build, about 2%.
Paying the sponsor adds ~6,900 more. That is the whole price of making chips
cheap and their tokens earnable.

## The mainnet program

[`asm/echo8.asm`](asm/echo8.asm) has no `hlt`, and cannot have one: if the
mother chip ever halts it halts forever. It echoes the sponsor's byte and
keeps a running sum in RAM — nine instructions, verified halt-free for
20,000 cycles on the synthesised netlist and 90 inside the EVM before
deployment.

## The market lives on pons

The token trades on [pons](https://www.ponsfamily.com/launchpad),
pump-style on Robinhood Chain: a bonding curve until 4.2 ETH is raised,
then graduation into a pool whose liquidity is locked. Pairs with ETH or
tokenised stocks. The factory does not care who created the token — a naked
chip adopts it once, forever:

```bash
# fund the reserve AND attach, in the only safe order (fund first):
RH4_FACTORY=0x… node tools/attach8.js --chip 1 --token 0x… --reserve 250000000 --target 77760000 --dry-run
```

The attach refuses an unfunded reserve by design: `_reward` retires the
emission forever on the first empty-reserve tick, so the reserve must be in
the factory before the clock can find it. Once in, there is no way out but
`tick()` — the anti-rug is the same as ever, just funded by the developer
buy instead of a mint-time split.

The factory can still open a factory-native market for chips that want one
(`tools/pool.js`, a single-sided Uniswap v3 range order — zero ETH in, the
buy side built by buyers). The two paths coexist; pons is where the mother
trades.

## The site is the processor

`docs/` is the site. It is not a video of the processor — `tools/webgen8.js`
packs the very netlist the contract interprets, and the visitor's browser
executes it gate by gate at 10 Hz, RAM and input port handled exactly as the
contract handles them. Type a byte into the IN port and watch the program
chew it.

## Building the whole chain of proofs

```bash
make rh8    # RTL sim, synthesis, netlist sim, codegen, forge tests: all four proofs
```

Requires `brew install yosys icarus-verilog`, [foundry](https://getfoundry.sh),
`npm install`, `forge install foundry-rs/forge-std --no-git` and
`forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git`.

```
rtl/rh8.v              the processor — 29 opcodes, IN port, RAM interface
asm/echo8.asm          the mainnet program: never halts, always listens
tools/asm8.js          assembler → build/*.slots8.json
tools/netlist.js       loads the yosys netlist, sorts the NANDs topologically
tools/netsim8.js       gate-level simulator (the oracle for the codegen)
tools/codegen8.js      netlist → src/RH8Gates.sol (interpreted gate table)
tools/webgen8.js       netlist → docs/rh8-data.js (the browser machine)
tools/deploy-factory8.js  puts the factory on the chain
tools/keeper.js        keeps a clock, sweeps everything it mines
tools/pool.js          opens the market: single-sided v3 range order
src/RH8Gates.sol       GENERATED — do not edit; make regenerates it
src/ChipFactory8.sol   the factory: ERC-721, ROM, RAM, permissionless clock
src/ChipToken.sol      fixed supply, no mint, owner() follows the chip NFT
src/Chip8Renderer.sol  the NFT draws itself on-chain from the real 171 bits
test/                  57 tests across both generations
```

The first generation — `rtl/rh4.v`, its unrolled 1,029-gate Yul build and
its tests — remains in the repo, verified and intact. It is the ancestor,
not the product.

## ISA, briefly

25-bit words, sixteen 8-bit registers, a 10-bit PC, 1,024 words of ROM,
single-cycle execution (except `ld`, two honest cycles). Twenty-nine
opcodes: the full table is on the site, under § 05. There is a `nand` in
the instruction set because the processor is NANDs — it seemed rude not to.
