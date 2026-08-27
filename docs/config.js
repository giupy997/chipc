/**
 * config.js — dove sta la fabbrica.
 *
 * Generazione RH-8, deployata in mainnet il 27 agosto 2026.
 *   RH8GateArray  0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a
 *   Chip8Renderer 0xAa432a98935CA6fb7159514876cC57aEF191B4B1
 *   ChipFactory8  0xeccac4acddf9fb8f2cdb8d7ddaf8daf4192bf92c
 *   chip #1       RH4 CPU (RH4), la madre — programma echo8
 *   token RH4     0xE70BB9bDF7a1FAe9a8CeF68f19a025Da274f4E41
 *   pool          0xf2829F1Abaebf1E59191bfeF7Ed5A7Aeaa87d409  (WETH/RH4 1%)
 *
 * Le due fabbriche precedenti (0xa135…84cd a 4 bit, 0x46af…9d06 con il gate
 * del clock sul blocco della chain madre) furono abbandonate pre-lancio.
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: "0xeccac4acddf9fb8f2cdb8d7ddaf8daf4192bf92c",
  gateArray: "0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a",
  defaultChip: 1,
};
