# RH4 — Token Distribution and Emission

Token: **rh4.cpu (RH4)** · `0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B` · Robinhood Chain (chain id 4663) · 18 decimals
Explorer: https://robinhoodchain.blockscout.com/token/0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B
Site: https://rh4cpu.tech · Technical reference: [INTEGRATION.md](INTEGRATION.md)

## Supply

| | Amount | Share |
|---|---|---|
| Total supply (fixed, no mint function) | 1,000,000,000 RH4 | 100% |
| Public sale on pons (bonding curve, 31 Aug 2026) | 700,000,000 RH4 | 70% |
| Mining reserve, sealed in the factory contract | 300,000,000 RH4 | 30% |
| Team / treasury / advisors / vesting | 0 | 0% |

Token generation date: **31 August 2026**. The public 70% was sold on the
[pons](https://www.ponsfamily.com/launchpad/0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B)
bonding curve and graduated into a Uniswap v4 pool on Robinhood Chain
(pool id `0x2f71a0c969ed55abfb7ff1e26072e2122d5cc9a9f84386021f0530b34038ea2f`,
tracked on [GeckoTerminal](https://www.geckoterminal.com/robinhood/pools/0x2f71a0c969ed55abfb7ff1e26072e2122d5cc9a9f84386021f0530b34038ea2f)).

## The 30% is not a wallet

The reserve lives in **ChipFactory8**
(`0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b`, verified on Blockscout).
The contract has **no withdraw, transfer or admin-drain function**. The only
way RH4 leaves the reserve is `tick(uint256 id)`: whoever pays the gas to
advance the on-chain processor by one clock cycle receives a fixed reward
from the reserve, in the same transaction. Anyone can call it; nobody can
call it more than once per block.

Live parameters (6 Sep 2026, readable on-chain via `emission(1)`):

| | |
|---|---|
| Reward per clock cycle | 3.858 RH4 |
| Cycles left in the current schedule | ~77.9M |
| Reserve balance | ~300.37M RH4 (30% + buybacks) |
| Full-clock duration | ~90 days at 10 cycles/second; longer if the chip idles |

Emission is therefore **demand-driven**: it happens only when someone finds
a cycle worth its gas. If nobody ticks, nothing is emitted.

## Buybacks feed the reserve

Every chip minted on the launchpad opens a Uniswap v3 market whose liquidity
position is minted straight into a vault contract with no withdraw function.
The reserve share of the 1% trading fees on those markets (in ETH or in
tokenised stocks such as NVDA) is converted to ETH and used to **buy RH4
back into the factory reserve** automatically
([ChipBuybackVault](src/ChipBuybackVault.sol), verified). Bought-back RH4
follows the same emission rule: it only leaves through `tick()`.

## What holders should know

- No unlocks, no cliffs, no vesting: there is nothing scheduled to hit the market.
- No team allocation: the deployer holds no reserved supply.
- Circulating supply = total supply − factory reserve balance
  (`balanceOf(factory)`), plus whatever the reserve has emitted since.
- Contracts are immutable; the only privileged action in the system is
  appointing the keeper that executes buybacks, and that keeper cannot
  extract anything (RH4 can only land in the factory).
