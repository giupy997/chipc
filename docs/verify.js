/**
 * verify.js — la verifica del sorgente dei token dei chip, dal browser.
 *
 * Ogni ChipToken nasce dalla fabbrica con lo stesso codice e argomenti
 * diversi (nome, ticker, id, quota in liquidita', coniatore). Blockscout
 * non li riconosce da solo perche' gli immutabili cambiano il bytecode,
 * quindi glieli presentiamo noi: lo standard-JSON del compilatore (dal
 * repo) piu' gli argomenti ricostruiti dalla chain. Parte da sola dopo il
 * mint; sul chip page c'e' un bottone se per qualche motivo non e' passata.
 * Il verificatore di Blockscout accetta solo richieste da un browser, per
 * questo vive qui e non nel keeper.
 */
(function () {
  "use strict";
  const CFG = () => window.RH4_CONFIG || {};
  const STD_JSON = "https://raw.githubusercontent.com/giupy997/chipc/main/verify/ChipToken.std.json";
  const COMPILER = "v0.8.28+commit.7893614a";
  const TOKEN_SUPPLY = 10n ** 27n;
  const S_CHIP = "0x8c6aefcf";

  // ---- ABI: (string,string,uint256,uint256,address,uint256,address) --------
  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const addrWord = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  const strBytes = (s) => {
    const b = new TextEncoder().encode(s);
    let hex = ""; for (const x of b) hex += x.toString(16).padStart(2, "0");
    return word(b.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  };
  function encodeArgs(name, symbol, chipId, toLiquidity, factory, minter) {
    const head = [word(0xe0), word(0), word(chipId), word(TOKEN_SUPPLY), addrWord(factory), word(toLiquidity), addrWord(minter)];
    const s1 = strBytes(name);
    head[1] = word(0xe0 + s1.length / 2);
    return "0x" + head.join("") + s1 + strBytes(symbol);
  }

  async function rpc(method, params) {
    const r = await fetch(CFG().rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }
  const b32ToString = (hex) => { const bytes = []; for (let i = 0; i < 64; i += 2) { const c = parseInt(hex.slice(i, i + 2), 16); if (c === 0) break; bytes.push(c); } return new TextDecoder().decode(new Uint8Array(bytes)); };

  /** Gli argomenti del costruttore di un chip, letti dalla chain. */
  async function argsFor(id) {
    const F = CFG().factoryFor(id);
    const chip = await rpc("eth_call", [{ to: F, data: S_CHIP + word(id) }, "latest"]);
    const w = (i) => chip.slice(2 + i * 64, 2 + (i + 1) * 64);
    const label = b32ToString(w(1)), ticker = b32ToString(w(2)), minter = "0x" + w(3).slice(24), token = "0x" + w(6).slice(24);
    // TokenLaunched(id indexed, token indexed, toLiquidity, reserve, reward)
    const logs = await rpc("eth_getLogs", [{ address: F, topics: [TOPIC_LAUNCHED_REAL, "0x" + word(id)], fromBlock: "0x" + Number(CFG().genesisBlock || 1).toString(16), toBlock: "latest" }]);
    if (!logs.length) throw new Error("no TokenLaunched event for this chip");
    const toLiquidity = BigInt("0x" + logs[0].data.slice(2, 66));
    return { token, args: encodeArgs(label, ticker, id, toLiquidity, F, minter) };
  }
  // keccak256("TokenLaunched(uint256,address,uint256,uint256,uint256)")
  const TOPIC_LAUNCHED_REAL = "0x37a15ad6422bd0641fc4188d5b385eac92d644ea1a48795b158b196d52423818";

  const api = () => (CFG().explorer || "https://robinhoodchain.blockscout.com") + "/api/v2/smart-contracts/";

  /** Verificato? null se Blockscout non risponde. */
  async function isVerified(token) {
    try { const r = await fetch(api() + token).then((x) => x.json()); return Boolean(r && r.is_verified); }
    catch (_) { return null; }
  }

  /** Presenta il sorgente per il token del chip `id`. Ritorna "ok", "already" o un messaggio. */
  async function verifyChip(id) {
    const { token, args } = await argsFor(id);
    if (await isVerified(token)) return "already";
    const json = await fetch(STD_JSON).then((r) => r.blob());
    const fd = new FormData();
    fd.append("compiler_version", COMPILER);
    fd.append("contract_name", "ChipToken");
    fd.append("autodetect_constructor_args", "false");
    fd.append("constructor_args", args);
    fd.append("license_type", "mit");
    fd.append("files[0]", new File([json], "input.json", { type: "application/json" }));
    const res = await fetch(api() + token + "/verification/via/standard-input", { method: "POST", body: fd });
    const body = await res.text();
    if (res.status === 200) return "ok";
    if (res.status === 429) return "rate-limited by the explorer — try again in a few minutes";
    return `explorer said ${res.status}: ${body.slice(0, 80)}`;
  }

  window.RH4_VERIFY = { verifyChip, isVerified, encodeArgs, argsFor };
})();
