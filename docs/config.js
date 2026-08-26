/**
 * config.js — dove sta la fabbrica.
 *
 * Generazione RH-8, deployata in mainnet il 27 agosto 2026.
 *   RH8GateArray  0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a
 *   Chip8Renderer 0xAa432a98935CA6fb7159514876cC57aEF191B4B1
 *   ChipFactory8  0x46afc7855c97c351cfae8fd888433854f5f29d06
 *   chip #1       RH4 CPU (RH4), la madre — programma echo8
 *   token RH4     0x152823600412791de3dB262eBD9883Dd9f54d7B1
 *   pool          0xF6f438BFB8420012BdfA75F3Cf81faBAa78aF511  (WETH/RH4 1%)
 *
 * (La prima generazione, fabbrica 0xa135…84cd, fu abbandonata pre-lancio.)
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: "0x46afc7855c97c351cfae8fd888433854f5f29d06",
  gateArray: "0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a",
  defaultChip: 1,
};
