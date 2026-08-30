/**
 * config.js — dove sta la fabbrica.
 *
 * Ripartenza, 31 agosto 2026. Gli indirizzi pubblici (token, mercato)
 * si annunciano tutti insieme al lancio: qui c'e' solo cio' che serve
 * al bottone POWER — la fabbrica del chip #1.
 *
 *   RH8GateArray  0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a  (riusato)
 *   Chip8Renderer 0xd6e71a902a927C2d36110d35769ed49bf8705b28  (riusato)
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: "0xd73c9a8ffe2c40deba8bc0ba6bc5b61db7ce86eb",
  gateArray: "0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a",
  defaultChip: 1,
};
