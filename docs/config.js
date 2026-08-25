/**
 * config.js — dove sta la fabbrica.
 *
 * Finche' `factory` e' null il bottone "power this chip" resta spento e lo
 * dice. Al deploy si riempiono questi tre valori e il sito diventa vivo
 * senza toccare una riga di codice.
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: null,   // ChipFactory, da riempire al deploy
  gateArray: null, // RH4GateArray
  defaultChip: 1,  // quale chip mostra il bottone
};
