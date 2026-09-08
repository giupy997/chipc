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

  // ChipFactory9 (8 set 2026): ticker fino a 12, id che continuano dalla v8
  // (dal 43), restart onesto, riserva in pausa e non spenta, attach solo
  // di token ammessi. Qui si conia.
  factory: "0x4a5E39B8a41c169210d1F7dCD307854330D8144C",
  // La fabbrica di prima (ChipFactory8). Gli id continuano: i chip 1..42
  // vivono li' (con i loro link nel suo ChipSocials), quelli dopo nella
  // fabbrica viva. `factoryFor(id)` e `socialsFor(id)` in fondo al file scelgono.
  legacy: { factory: "0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b", socials: "0x355A7C6d677944979bf604080698f131E0B72891", lastId: 42 },
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
  // v4 (8 set 2026), per la ChipFactory9: come i v3, con l'RH4 ricomprato che
  // torna nella riserva della madre sulla ChipFactory8.
  feeVault: "0x64F26350754f33ea0F9C5A2771a4757435623533",       // 100% riserva + buyback RH4
  creatorVault: "0x094943a2ff18b4d3b28a05A37E5dF10599a9223B",   // 50/50 (claim) + buyback RH4
  // i vault delle generazioni prima, con le loro posizioni: si riscuotono,
  // si convertono e pagano i creator come prima
  creatorVaultsLegacy: ["0x99cbC09CF1221237565Edc3EE77f11D9D1Ba3c7A", "0x48B8CdbF29d65981F9dFbc4176A868AcE28c30Aa"],   // 50/50 v3, v2
  feeVaultsLegacy: ["0xEE42d4708A0Faec9f896C9283001dCb1e4C15CAC", "0x2F9D010BE1D2b8F304Bb1c0a02fe9277Fcdb3896"],       // 100% v3, v2
  legacyVaults: [
    "0xc7d42eefe7Ba99F35E37cE4b8eBEBB3e66691233",   // 50/50 prima generazione
    "0xb5C467bA319a1aCe5baCe0ffd45f6582C3AE491D",   // 100% riserva prima generazione
  ],
  // ChipSocials: i link (X, sito, Telegram) di ogni chip, on-chain.
  socials: "0xbc06c136239edb6BEa11F203a5334b2Ac00F2274",   // ChipSocials della ChipFactory9 (quello della v8 sta in legacy)
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
    // 8 set 2026: i pool WETH piu' profondi fra i 194 token Robinhood, scansionati uno a uno
    { sym: "GLD", name: "SPDR Gold", address: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e" },      // pool WETH 139 ETH, fee 1%
    { sym: "HIMS", name: "Hims & Hers", address: "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09" },    // pool WETH 99 ETH, fee 1%
    { sym: "AMC", name: "AMC Entertainment", address: "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B" }, // pool WETH 96 ETH, fee 1%
    { sym: "RBLX", name: "Roblox", address: "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8" },         // pool WETH 39 ETH, fee 0.3%
    { sym: "CRCL", name: "Circle", address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5" },         // pool WETH 33 ETH, fee 1%
    { sym: "QQQ", name: "Invesco QQQ", address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68" },     // pool WETH 30 ETH, fee 0.3%
    { sym: "DJT", name: "Trump Media", address: "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516" },     // pool WETH 29 ETH, fee 0.3%
    { sym: "META", name: "Meta", address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35" },           // pool WETH 24 ETH, fee 0.3%
    { sym: "SGOV", name: "iShares 0-3M Treasury", address: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5" }, // pool WETH 20 ETH, fee 1%
    { sym: "LLY", name: "Eli Lilly", address: "0x8005d266423c7ea827372c9c864491e5786600ea" },       // pool WETH 11 ETH, fee 0.3%
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
  holdersVault: "0xFBB3bac91aeFb37277318a74D0D13D118b1B12AA",   // ChipHoldersVault2 per la ChipFactory9 (8 set 2026), executor keeper
  holdersPath: "holders9",
  // il vault holders della v8, con CHIPCAT dentro: epoche gia' scritte in docs/holders
  holdersVaultsLegacy: [{ vault: "0xF9E80B7422a3D3F2230B4Bb26c3b3A255817A518", path: "holders" }],

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
// dove vive un chip: nella fabbrica di prima fino a legacy.lastId, poi in quella viva
window.RH4_CONFIG.factoryFor = function (id) {
  const L = this.legacy || {};
  return L.factory && Number(id) <= Number(L.lastId || 0) ? L.factory : this.factory;
};
window.RH4_CONFIG.socialsFor = function (id) {
  const L = this.legacy || {};
  return L.socials && Number(id) <= Number(L.lastId || 0) ? L.socials : this.socials;
};
