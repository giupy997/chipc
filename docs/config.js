/**
 * config.js — dove sta la fabbrica.
 *
 * Deployata in mainnet il 26 agosto 2026.
 *   RH4GateArray  0x7f6272273ebd9eb1c7491dcbf959c2750c98ec2d
 *   ChipRenderer  0x6844caa761b43a28d694447df6139a84310243a9
 *   ChipFactory   0x825d87157899791e738707d96477d04268e62578
 *   chip #1       Behemoth (BHMT), la madre
 *   token BHMT    0x4c07Db6EaA85a8cCF4E99eD0F2279f9c5389118C
 *   pool          0x948C1A1619bc2961A7db05FA36120fd00b212Ecf  (WETH/BHMT 1%)
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: "0x825d87157899791e738707d96477d04268e62578",
  gateArray: "0x7f6272273ebd9eb1c7491dcbf959c2750c98ec2d",
  defaultChip: 1,  // quale chip mostra il bottone
};
