/**
 * config.js — dove sta la fabbrica.
 *
 * Ripartenza (30/70), 31 agosto 2026. 70% al pubblico su pons, 30% (il
 * dev buy) sigillato in fabbrica come riserva di mining. Token live su pons:
 *   0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B
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

  factory: "0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b",
  token: "0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B",
  // I vault delle fee: le posizioni LP nascono qui e non escono mai. Dalla
  // generazione buyback, la quota "riserva" della quote ricompra RH4 per
  // la madre invece di restare sepolta. I vecchi restano riconosciuti.
  feeVault: "0xc126579fe50Db740534053e3312aBb460A8A6e9e",       // 100% riserva + buyback RH4
  creatorVault: "0xAbc4F8e14879Bb9Cb1871953E5715fe5787AB363",   // 50/50 (claim) + buyback RH4
  legacyVaults: [
    "0xc7d42eefe7Ba99F35E37cE4b8eBEBB3e66691233",   // 50/50 prima generazione (TCHIP)
    "0xb5C467bA319a1aCe5baCe0ffd45f6582C3AE491D",   // 100% riserva prima generazione
  ],
  // ChipSocials: i link (X, sito, Telegram) di ogni chip, on-chain.
  socials: "0x355A7C6d677944979bf604080698f131E0B72891",
  gateArray: "0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a",
  defaultChip: 1,
  // da dove leggere gli eventi (poco prima della fabbrica di questa generazione)
  genesisBlock: 51500000,

  // Il cancello del launchpad: finche' e' false il bottone MINT resta
  // spento sul sito pubblico. Si apre con un flip qui, al T-0.
  launchpadOpen: false,
};
