/**
 * config.js — dove sta la fabbrica.
 *
 * Deployment del lancio, 27 agosto 2026.
 *   RH8GateArray  0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a  (riusato)
 *   Chip8Renderer 0xAa432a98935CA6fb7159514876cC57aEF191B4B1  (riusato)
 *   ChipFactory8  0x8429c2c06442c01d916c1286573d0948efcea0ea
 *   chip #1       rh4.cpu (RH4), la madre — programma echo8
 *   token RH4     0xE031CA34143B579aE3B38a523830379f19a904fC
 *   pool          0x0eF8320E8D6203013B77d63f52102E11c0b95407  (WETH/RH4 1%)
 *
 * 60% dell'offerta nel pool, 400M alla riserva dei cicli (5,14/ciclo, 90gg).
 * Il token espone owner() = proprietario dell'NFT del chip.
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: "0x8429c2c06442c01d916c1286573d0948efcea0ea",
  gateArray: "0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a",
  defaultChip: 1,
};
