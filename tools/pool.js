#!/usr/bin/env node
/**
 * pool.js — apre il mercato di un chip con un range order a un lato solo.
 *
 *   PRIVATE_KEY=0x... node tools/pool.js --chip 1
 *
 *     --chip N        legge il token dalla fabbrica (serve RH4_FACTORY)
 *     --token 0x...   oppure il token direttamente
 *     --amount N      quanti token mettere nel range (default: tutto il saldo)
 *     --fdv-start N   FDV in ETH a cui parte il range   (default 5)
 *     --fdv-end N     FDV in ETH a cui finisce          (default 50)
 *     --fee N         fee tier in centesimi di bps: 500 | 3000 | 10000 (def.)
 *     --quote NOME    con cosa accoppiare: weth (default), nvda, sndk, spcx,
 *                     oppure un indirizzo. Gli FDV restano espressi in ETH:
 *                     la conversione passa dal pool quote/WETH.
 *     --rate N        forza il cambio ETH per unita' di quote, invece di
 *                     leggerlo dalla chain. Serve quando il pool di
 *                     riferimento e' troppo sottile per dire un prezzo.
 *     --dry-run       calcola tutto e non manda niente
 *
 * ------------------------------------------------------------------------
 *  Perche' un lato solo
 * ------------------------------------------------------------------------
 * In Uniswap v3 una posizione interamente sopra il prezzo corrente contiene
 * SOLO il token, zero ETH. Il pool parte dal prezzo minimo del range e, man
 * mano che qualcuno compra, i token si convertono in ETH dentro la posizione.
 *
 * Ne segue la cosa che rende questo lancio possibile senza capitale:
 * **l'ETH della liquidita' lo mettono i compratori.** La posizione resta tua,
 * e l'ETH che ci si accumula pure.
 *
 * Il prezzo che si paga: all'inizio non esiste lato acquisto. Chi vuole
 * vendere puo' farlo solo contro l'ETH accumulato fino a quel momento.
 *
 * ------------------------------------------------------------------------
 *  Indirizzi su Robinhood Chain
 * ------------------------------------------------------------------------
 * Non sono quelli canonici di Uniswap: a quelli ci sono stub vuoti. Questi
 * li ho ricavati leggendo `factory()` da un pool vivo e risalendo a chi lo
 * mintava, poi verificati (name = "Uniswap V3 Positions NFT-V1", e factory
 * e WETH9 del manager combaciano con la factory trovata).
 */

const fs = require("fs");
const {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseUnits,
  encodeFunctionData,
  getAddress,
} = require("viem");
const { DEFAULT_RPC, chainFor, accountFromEnv, parseArgs } = require("./chain");

const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/**
 * Titoli tokenizzati su Robinhood Chain, tutti a 18 decimali (verificato).
 *
 * Attenzione: su questa chain esistono parecchi impostori con le stesse
 * sigle. Questi sono quelli ufficiali, riconoscibili dal nome che finisce
 * con "• Robinhood Token".
 */
const QUOTES = {
  weth: WETH,
  nvda: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", // NVIDIA
  sndk: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", // SanDisk
  spcx: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", // SpaceX
};

const TOTAL_SUPPLY = 1_000_000_000; // il ChipToken ne conia sempre un miliardo
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const SPACING = { 500: 10, 3000: 60, 10000: 200 };

/** Sotto questa profondita' il pool di riferimento non dice un prezzo vero. */
const MIN_QUOTE_DEPTH = 50000000000000000n; // 0,05 WETH

// ---------------------------------------------------------------- tick math

/**
 * TickMath.getSqrtRatioAtTick, portato pari pari da Uniswap.
 *
 * Si potrebbe fare con Math.sqrt e i float, ma allora il prezzo iniziale non
 * cadrebbe *esattamente* sul bordo del tick, e la posizione non sarebbe piu'
 * a un lato solo: servirebbe un pizzico di ETH che non abbiamo.
 */
function getSqrtRatioAtTick(tick) {
  const abs = BigInt(Math.abs(tick));
  const Q128 = 1n << 128n;
  let ratio = (abs & 0x1n) !== 0n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : Q128;

  const muls = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, m] of muls) {
    if ((abs & bit) !== 0n) ratio = (ratio * m) >> 128n;
  }

  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;

  // da Q128.128 a Q64.96, arrotondando per eccesso
  const shifted = ratio >> 32n;
  return shifted + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Il tick il cui prezzo e' il piu' vicino da sotto a `price` (token1/token0). */
function tickAtPrice(price) {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

const floorToSpacing = (t, s) => Math.floor(t / s) * s;

// --------------------------------------------------------------------- abi

const NPM_ABI = [
  {
    type: "function",
    name: "createAndInitializePoolIfNecessary",
    stateMutability: "payable",
    inputs: [
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [{
      name: "params",
      type: "tuple",
      components: [
        { name: "token0", type: "address" },
        { name: "token1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickLower", type: "int24" },
        { name: "tickUpper", type: "int24" },
        { name: "amount0Desired", type: "uint256" },
        { name: "amount1Desired", type: "uint256" },
        { name: "amount0Min", type: "uint256" },
        { name: "amount1Min", type: "uint256" },
        { name: "recipient", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    }],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
];

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }],
    outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view",
    inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint8" }] },
];

const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" }, { name: "unlocked", type: "bool" },
    ] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint128" }] },
];

const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }] },
];

const CHIP_ABI = [
  { type: "function", name: "emission", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "reserveLeft", type: "uint256" },
      { name: "rewardPerCycle", type: "uint256" },
      { name: "cyclesLeft", type: "uint256" },
    ] },
];

/**
 * Quanti ETH vale un'unita' del token di quotazione.
 *
 * Senza questo il range andrebbe espresso in unita' del quote — "FDV da 5 a
 * 50 azioni NVIDIA" non dice niente a nessuno. Passando dal pool quote/WETH
 * i numeri restano leggibili in ETH qualunque sia la coppia.
 */
async function ethPerQuote(pub, quote) {
  if (quote.toLowerCase() === WETH.toLowerCase()) return 1;

  const [a, b] = quote.toLowerCase() < WETH.toLowerCase() ? [quote, WETH] : [WETH, quote];
  let best = null;
  for (const fee of [500, 3000, 10000]) {
    const addr = await pub.readContract({
      address: V3_FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [a, b, fee],
    });
    if (addr === "0x0000000000000000000000000000000000000000") continue;
    const liq = await pub.readContract({ address: addr, abi: POOL_ABI, functionName: "liquidity" });
    // il pool piu' liquido e' quello di cui fidarsi per il prezzo
    if (!best || liq > best.liq) best = { addr, liq, fee };
  }
  if (!best || best.liq === 0n) {
    throw new Error("nessun pool quote/WETH con liquidita': non so quanto vale in ETH");
  }

  // Un pool vuoto ha comunque uno slot0, e quel prezzo e' inventato. Senza
  // questo controllo il range finirebbe piazzato su un cambio che non e' mai
  // stato scambiato da nessuno.
  const depth = await pub.readContract({
    address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [best.addr],
  });
  if (depth < MIN_QUOTE_DEPTH) {
    throw new Error(
      `il pool di riferimento ha solo ${formatEther(depth)} WETH: troppo poco ` +
      `per dire un prezzo.\n  Se sai tu quanto vale, passalo con --rate <ETH per unita'>.`
    );
  }

  const [sqrt] = await pub.readContract({
    address: best.addr, abi: POOL_ABI, functionName: "slot0",
  });
  // price = token1 per token0
  const price = (Number(sqrt) / 2 ** 96) ** 2;
  const wethIsToken0 = a.toLowerCase() === WETH.toLowerCase();
  // se WETH e' token0, price = quote per WETH, quindi si inverte
  const eth = wethIsToken0 ? 1 / price : price;
  return { eth, pool: best.addr, fee: best.fee, depth };
}

// -------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2), ["dry-run"]);
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  const dryRun = Boolean(args["dry-run"]);
  const fee = Number(args.fee || 10000);
  const spacing = SPACING[fee];
  if (!spacing) {
    console.error(`fee tier non valido: ${fee} (usa 500, 3000 o 10000)`);
    process.exit(2);
  }

  const fdvStart = Number(args["fdv-start"] || 5);
  const fdvEnd = Number(args["fdv-end"] || 50);
  if (!(fdvEnd > fdvStart) || fdvStart <= 0) {
    console.error("serve 0 < --fdv-start < --fdv-end");
    process.exit(2);
  }

  const chain = chainFor(rpc);
  const account = accountFromEnv();
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  // --- quale token ---
  let token = args.token;
  if (!token) {
    const factory = args.factory || process.env.RH4_FACTORY;
    if (!factory || !args.chip) {
      console.error("serve --token 0x… oppure --chip N con RH4_FACTORY impostato");
      process.exit(2);
    }
    const [t] = await pub.readContract({
      address: factory, abi: CHIP_ABI, functionName: "emission",
      args: [BigInt(args.chip)],
    });
    token = t;
    if (token === "0x0000000000000000000000000000000000000000") {
      console.error(`il chip #${args.chip} non ha ancora un token`);
      process.exit(1);
    }
  }
  token = getAddress(token);

  const symbol = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" });
  const balance = await pub.readContract({
    address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
  // In dry-run il saldo non deve fermare niente: serve a decidere prima di
  // avere i token in mano, non dopo.
  const amount = args.amount
    ? parseUnits(String(args.amount), 18)
    : balance !== 0n ? balance : parseUnits(String(TOTAL_SUPPLY * 0.2), 18);

  if (amount > balance) {
    const msg = `saldo insufficiente: hai ${formatEther(balance)} ${symbol}, ne servono ${formatEther(amount)}`;
    if (!dryRun) {
      console.error(msg);
      process.exit(1);
    }
    console.log(`  ATTENZIONE  ${msg}`);
  }

  // --- con cosa accoppiamo ---
  const qArg = String(args.quote || "weth").toLowerCase();
  const quoteAddr = QUOTES[qArg] || (qArg.startsWith("0x") ? qArg : null);
  if (!quoteAddr) {
    console.error(`quote sconosciuto: ${qArg} (usa ${Object.keys(QUOTES).join(", ")} o un indirizzo)`);
    process.exit(2);
  }
  const quote = getAddress(quoteAddr);
  const quoteSymbol = await pub.readContract({ address: quote, abi: ERC20_ABI, functionName: "symbol" });
  const quoteDecimals = await pub.readContract({ address: quote, abi: ERC20_ABI, functionName: "decimals" });
  if (quoteDecimals !== 18) {
    console.error(`${quoteSymbol} ha ${quoteDecimals} decimali: i conti del range assumono 18`);
    process.exit(2);
  }

  // Gli FDV restano in ETH anche accoppiando con un titolo: si converte.
  let conv, rate;
  if (args.rate) {
    rate = Number(args.rate);
    conv = { forced: true };
  } else {
    conv = await ethPerQuote(pub, quote);
    rate = typeof conv === "number" ? conv : conv.eth;
  }

  // --- ordinamento e range ---
  const ourIsToken0 = token.toLowerCase() < quote.toLowerCase();
  const [token0, token1] = ourIsToken0 ? [token, quote] : [quote, token];

  // Il prezzo in v3 e' sempre token1 per token0. Il nostro riferimento e'
  // invece l'FDV in ETH, quindi la conversione cambia con l'ordinamento.
  // FDV in ETH -> FDV in unita' di quote -> prezzo per token
  const qStart = fdvStart / rate;
  const qEnd = fdvEnd / rate;

  let tickLower, tickUpper, initTick;
  if (ourIsToken0) {
    // prezzo = quote per token, cresce con l'FDV
    tickLower = floorToSpacing(tickAtPrice(qStart / TOTAL_SUPPLY), spacing);
    tickUpper = floorToSpacing(tickAtPrice(qEnd / TOTAL_SUPPLY), spacing);
    if (tickUpper <= tickLower) tickUpper = tickLower + spacing;
    initTick = tickLower; // il pool parte in fondo: la posizione e' tutta token
  } else {
    // prezzo = token per quote, DEcresce con l'FDV
    tickLower = floorToSpacing(tickAtPrice(TOTAL_SUPPLY / qEnd), spacing);
    tickUpper = floorToSpacing(tickAtPrice(TOTAL_SUPPLY / qStart), spacing);
    if (tickUpper <= tickLower) tickUpper = tickLower + spacing;
    initTick = tickUpper; // il pool parte in cima: la posizione e' tutta token
  }
  if (tickLower < MIN_TICK || tickUpper > MAX_TICK) {
    console.error("il range esce dai limiti di Uniswap: rivedi gli FDV");
    process.exit(2);
  }

  const sqrtPriceX96 = getSqrtRatioAtTick(initTick);

  console.log("range order a un lato solo");
  console.log(`  rete        ${chain.name} (${chain.id})`);
  console.log(`  wallet      ${account.address}`);
  console.log(`  token       ${symbol}  ${token}`);
  console.log(`  in gioco    ${formatEther(amount)} ${symbol} (${(Number(formatEther(amount)) / TOTAL_SUPPLY * 100).toFixed(1)}% dell'offerta)`);
  console.log(`  ${quoteSymbol} da te${" ".repeat(Math.max(0, 6 - quoteSymbol.length))} 0 — lo mettono i compratori`);
  console.log(`  coppia      ${ourIsToken0 ? `${symbol}/${quoteSymbol}` : `${quoteSymbol}/${symbol}`}, fee ${fee / 10000}%`);
  if (rate !== 1) {
    console.log(
      `  cambio      1 ${quoteSymbol} = ${rate.toPrecision(6)} ETH  ` +
      (conv.forced
        ? "(forzato con --rate)"
        : `(pool ${conv.pool.slice(0, 10)}…, ${formatEther(conv.depth)} WETH di fondo)`)
    );
  }
  console.log(`  range       FDV da ${fdvStart} a ${fdvEnd} ETH` +
    (rate !== 1 ? `  =  da ${qStart.toPrecision(4)} a ${qEnd.toPrecision(4)} ${quoteSymbol}` : ""));
  console.log(`  tick        [${tickLower}, ${tickUpper}], pool inizializzato a ${initTick}`);

  const existing = await pub.readContract({
    address: V3_FACTORY, abi: FACTORY_ABI, functionName: "getPool",
    args: [token0, token1, fee],
  });
  const fresh = existing === "0x0000000000000000000000000000000000000000";
  console.log(`  pool        ${fresh ? "da creare" : `gia' esistente: ${existing}`}`);
  if (!fresh) {
    console.log("\nATTENZIONE: il pool c'e' gia'. Il prezzo NON verra' reinizializzato,");
    console.log("quindi il range potrebbe non essere piu' a un lato solo e la mint");
    console.log("potrebbe chiedere anche WETH. Controlla prima di procedere.");
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const mintParams = {
    token0, token1, fee,
    tickLower, tickUpper,
    amount0Desired: ourIsToken0 ? amount : 0n,
    amount1Desired: ourIsToken0 ? 0n : amount,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: account.address,
    deadline,
  };

  const calls = [
    encodeFunctionData({
      abi: NPM_ABI,
      functionName: "createAndInitializePoolIfNecessary",
      args: [token0, token1, fee, sqrtPriceX96],
    }),
    encodeFunctionData({ abi: NPM_ABI, functionName: "mint", args: [mintParams] }),
  ];

  if (dryRun) {
    console.log("\ndry run: non mando niente.");
    return;
  }

  // --- approvazione ---
  console.log("\n1/2  approvo il position manager");
  const approveHash = await wallet.writeContract({
    address: token, abi: ERC20_ABI, functionName: "approve", args: [NPM, amount],
  });
  await pub.waitForTransactionReceipt({ hash: approveHash, timeout: 120_000 });
  console.log(`     ${approveHash}`);

  // --- creazione e mint in una sola tx ---
  // Separarle lascerebbe a chiunque una finestra per inizializzare il pool a
  // un prezzo suo fra le due, e la posizione non sarebbe piu' a un lato solo.
  console.log("2/2  creo il pool e apro la posizione (una tx sola)");
  const { request } = await pub.simulateContract({
    address: NPM, abi: NPM_ABI, functionName: "multicall", args: [calls], account,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") {
    console.error(`     FALLITA  ${hash}`);
    process.exit(1);
  }
  console.log(`     ${hash}`);

  const pool = await pub.readContract({
    address: V3_FACTORY, abi: FACTORY_ABI, functionName: "getPool",
    args: [token0, token1, fee],
  });

  console.log("\n--- mercato aperto ---");
  console.log(`  pool        ${pool}`);
  console.log(`  speso       ${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} ETH di gas`);
  if (chain.blockExplorers) {
    console.log(`  explorer    ${chain.blockExplorers.default.url}/address/${pool}`);
  }
  console.log(`  chart       https://dexscreener.com/robinhood/${pool.toLowerCase()}`);
  console.log(`\nla posizione e' un NFT Uniswap nel tuo wallet: i ${quoteSymbol} che si`);
  console.log("accumulano man mano che comprano sono tuoi, si ritirano da li'.");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exit(1);
});
