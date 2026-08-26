/**
 * config.js — dove sta la fabbrica.
 *
 * Il primo deployment (fabbrica 0xa135…84cd, RH-4 a 4 bit) e' stato
 * abbandonato prima del lancio: il rilancio avviene sulla generazione a
 * 8 bit, con ingresso e RAM. Finche' `factory` e' null il bottone resta
 * spento e lo dice.
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: null,   // ChipFactory8, da riempire al rilancio
  gateArray: null, // RH8GateArray
  defaultChip: 1,
};
