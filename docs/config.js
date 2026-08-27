/**
 * config.js — dove sta la fabbrica.
 *
 * Deployment del lancio, 28 agosto 2026.
 *   RH8GateArray  0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a  (riusato)
 *   Chip8Renderer 0xd6e71a902a927C2d36110d35769ed49bf8705b28  (nuovo: baseURL = rh4cpu.tech)
 *   ChipFactory8  0x560da98cf01bd2c401f42e0d1ecab439b6539f67
 *   chip #1       rh4.cpu (RH4), la madre — programma echo8, logo on-site
 *   token RH4     0xCc94d9a27006B1556EF5dB40dDce1c4F5a1bF40C
 *   pool          0x5394Ba005834Ba041165AfBA965444e839fEAf09  (WETH/RH4 1%)
 *
 * 60% dell'offerta nel pool, 400M alla riserva dei cicli (5,14/ciclo, 90gg).
 * Il token espone owner() = proprietario dell'NFT del chip; ogni NFT linka
 * https://rh4cpu.tech/?chip=N via external_url.
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: "0x560da98cf01bd2c401f42e0d1ecab439b6539f67",
  gateArray: "0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a",
  defaultChip: 1,
};
