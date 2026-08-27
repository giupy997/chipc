/**
 * config.js — dove sta la fabbrica.
 *
 * Deployment definitivo, wallet fresco, 27 agosto 2026.
 *   RH8GateArray  0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a  (riusato)
 *   Chip8Renderer 0xAa432a98935CA6fb7159514876cC57aEF191B4B1  (riusato)
 *   ChipFactory8  0x2c5c2dd0ddc0fbef4a783b8ef7e571d74a08ca4a
 *   chip #1       RH4 CPU (RH4), la madre — programma echo8
 *   token RH4     0x307A7053931055650e21FA37298555179d3E9d36
 *   pool          0x66dfac26b9C8103E4da6f0487Af79af55F71E759  (WETH/RH4 1%)
 *
 * I deployment di prova precedenti sono abbandonati e non vanno linkati.
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: "0x2c5c2dd0ddc0fbef4a783b8ef7e571d74a08ca4a",
  gateArray: "0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a",
  defaultChip: 1,
};
