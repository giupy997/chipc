/**
 * config.js — dove sta la fabbrica.
 *
 * Deployata in mainnet il 26 agosto 2026.
 *   RH4GateArray  0x7f6272273EBd9EB1C7491dCBf959C2750c98ec2D
 *   ChipRenderer  0x48a367c644ffd4d881657ac58a376c1bd5955339
 *   ChipFactory   0xa13518ccd7d4d1dc15ca41f646290408af0384cd
 *   chip #1       RH4 CPU (RH4), la madre
 *   token RH4     0x2b858a1E61Bb118aA7991435e46F9647e7e087Ab
 *   pool          0x19D7b8cA3002949A0961D7a42c7F914efdbd9942  (WETH/RH4 1%)
 *
 * Il renderer non ha ancora il dominio: `external_url` resta assente finche'
 * non se ne deploya uno con --site e si chiama setRenderer.
 */
window.RH4_CONFIG = {
  chainId: 4663,
  chainIdHex: "0x1237",
  chainName: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",

  factory: "0xa13518ccd7d4d1dc15ca41f646290408af0384cd",
  gateArray: "0x7f6272273EBd9EB1C7491dCBf959C2750c98ec2D",
  defaultChip: 1,  // quale chip mostra il bottone
};
