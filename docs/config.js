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
  // I vault buyback v2: collect() di tutti (accredita, riserva, parcheggia),
  // convert()/buyback() solo dell'executor con minOut deciso fuori chain.
  // I v1 buyback (0xAbc4…, 0xc126…) sono ritirati: vuoti, mai usati.
  // v3 (7 set 2026): un chip token e' solo un token nato dalla fabbrica
  // (factory()/chipId()), non "quello che la fabbrica mappa": attachToken
  // lascia agganciare a un chip qualsiasi ERC20, e il v2 si fidava.
  feeVault: "0xEE42d4708A0Faec9f896C9283001dCb1e4C15CAC",       // 100% riserva + buyback RH4
  creatorVault: "0x99cbC09CF1221237565Edc3EE77f11D9D1Ba3c7A",   // 50/50 (claim) + buyback RH4
  // i v2, con le loro posizioni: si riscuotono, si convertono e pagano i creator come prima
  creatorVaultsLegacy: ["0x48B8CdbF29d65981F9dFbc4176A868AcE28c30Aa"],   // 50/50 v2
  feeVaultsLegacy: ["0x2F9D010BE1D2b8F304Bb1c0a02fe9277Fcdb3896"],       // 100% v2
  legacyVaults: [
    "0xc7d42eefe7Ba99F35E37cE4b8eBEBB3e66691233",   // 50/50 prima generazione
    "0xb5C467bA319a1aCe5baCe0ffd45f6582C3AE491D",   // 100% riserva prima generazione
  ],
  // ChipSocials: i link (X, sito, Telegram) di ogni chip, on-chain.
  socials: "0x355A7C6d677944979bf604080698f131E0B72891",
  gateArray: "0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a",
  defaultChip: 1,
  // dove sta la function che pinna i loghi su IPFS. Relativa finche' il sito
  // vive su Netlify; assoluta (https://<sito>.netlify.app/api/pin) quando il
  // sito vive su GitHub Pages e Netlify serve solo la function.
  pinEndpoint: "/api/pin",
  // da dove leggere gli eventi (poco prima della fabbrica di questa generazione)
  genesisBlock: 51500000,

  // Le quote oltre a WETH: azioni tokenizzate Robinhood con un pool WETH v3
  // profondo (>= 0.05 ETH). Da quel pool passano il tasso, la rotta del
  // trade panel e la conversione del vault, quindi senza pool niente quota.
  // Intel, AMD, Broadcom, Qualcomm esistono on-chain ma non hanno un pool
  // WETH (6 set 2026): fuori finche' qualcuno non lo apre.
  // `enabled: false` = si riconoscono i mercati gia' aperti (pool, chart,
  // fee, sweeper) ma il sito non offre di aprirne di nuovi. Per accendere
  // una quota basta togliere il flag.
  quotes: [
    { sym: "NVDA", name: "NVIDIA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
    { sym: "SNDK", name: "SanDisk", address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400" },   // pool WETH 32 ETH, fee 0.3% — live 6 set 2026
    { sym: "MU", name: "Micron", address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD" },     // pool WETH 15 ETH, fee 1% — live 6 set 2026
    { sym: "TSM", name: "TSMC", address: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA" },      // pool WETH 8.6 ETH, fee 0.3% — live 6 set 2026
    { sym: "AAPL", name: "Apple", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },    // pool WETH 21 ETH, fee 0.05% — live 6 set 2026
    { sym: "QUBT", name: "Quantum Computing", address: "0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4" }, // pool WETH 13 ETH, fee 1% — live 6 set 2026
    { sym: "SPCX", name: "SpaceX", address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa" },   // pool WETH 91 ETH, fee 0.05% — live 6 set 2026
    { sym: "TSLA", name: "Tesla", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },    // pool WETH 66 ETH, fee 0.3% — live 6 set 2026
    { sym: "SPY", name: "S&P 500 ETF", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" },   // pool WETH 182 ETH, fee 0.05% — live 7 set 2026
    { sym: "MSTR", name: "Strategy", address: "0xec262a75e413fAfD0dF80480274532C79D42da09" },    // pool WETH 176 ETH, fee 1% — live 7 set 2026
    { sym: "COIN", name: "Coinbase", address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b" },    // pool WETH 71 ETH, fee 0.3% — live 7 set 2026
    { sym: "RDDT", name: "Reddit", address: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C" },      // pool WETH 179 ETH, fee 1% — live 7 set 2026
    // USDG ha 6 decimali (le azioni e WETH 18): `decimals` guida prezzi, tick e soglie.
    { sym: "USDG", name: "Global Dollar", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 }, // pool WETH 5,600 ETH, fee 0.01% — live 6 set 2026
  ],

  // Mercati aperti prima del 5 settembre 2026 ~19:30 UTC: range order con
  // tetto a 50 ETH di FDV (sopra, niente liquidita'). Dal fix in poi il
  // sito apre senza tetto, quindi la lista non cresce piu'.
  cappedChips: [2, 3, 4, 5, 6, 9, 10, 11, 12],

  // Chip nascosti dal sito. Il 28 ("poison") ha agganciato NVDA come suo token
  // via attachToken (7 set 2026): la factory ha azzerato la sua ricompensa,
  // ma il chip resta e mostrerebbe il mcap di NVDA. Non e' un chip token.
  hiddenChips: [28, 31],   // 31 = LOCKWETH, il chip-guardia del team che tiene occupato lo slot di WETH

  // RH4StockVault: le fee della madre che diventano azioni per gli holder.
  // stockVault vuoto = sezione nascosta nel profilo. I pesi (bps) guidano il
  // keeper (tools/dividend.js) nel dividere l'ETH fra le azioni attive.
  stockVault: "0x6A3DF83dbC7A6d4879B8bA68B295f022be5594b7",   // deploy 7 set 2026, owner rh4-dev2, executor keeper
  // (solo le azioni attive nel vault contano; i pesi si rinormalizzano fra loro)
  stockVaultWeights: {
    "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC": 5000,   // NVDA
    "0xB90A19fF0Af67f7779afF50A882A9CfF42446400": 5000,   // SNDK
  },
  dividendsPath: "dividends",

  // ChipHoldersVault: la casa HOLDERS per le posizioni LP dei chip. 80% delle
  // fee agli holder del chip (a epoche, keeper: tools/holders.js), 20% riserva
  // e buyback RH4. Vuoto = la modalita' resta "incoming" sul sito.
  holdersVault: "0xF9E80B7422a3D3F2230B4Bb26c3b3A255817A518",   // v2, deploy 7 set 2026, executor keeper (v1 0xb76a…f057 ritirato, mai usato: si fidava della mappa della fabbrica)
  holdersPath: "holders",

  // Il launchpad a curva (src/curve: RH4Curve + CurveFeeVault). Contratti
  // scritti e testati, NON deployati. La pagina curve.html non ha link da
  // nessuna parte: con `enabled: false` mostra solo una porta chiusa, e con
  // `?preview` nell'URL la pagina in sola lettura (con `address` legge i
  // lanci veri). Per accendere: deploy, indirizzi qui, enabled: true.
  curve: { address: "", vault: "", enabled: false },

  // Il cancello del launchpad: finche' e' false il bottone MINT resta
  // spento sul sito pubblico. Si apre con un flip qui, al T-0.
  launchpadOpen: true,
};
