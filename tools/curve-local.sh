#!/bin/bash
# curve-local.sh — prova il launchpad a curva sul tuo wallet, senza toccare la chain vera.
#
#   bash tools/curve-local.sh 0xIL_TUO_INDIRIZZO
#
# Alza un fork locale di Robinhood Chain (anvil, chain id 46630 cosi' il wallet
# non lo confonde con quella vera), deploya RH4Curve + CurveFeeVault, apre le
# quote WETH e USDG, semina due lanci, ti regala 100 ETH finti e serve il sito
# su http://localhost:8124 con la curva accesa. Ctrl+C spegne tutto.
# Niente chiavi: il deploy usa l'impersonazione di anvil.
set -e
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
ME=${1:?"uso: bash tools/curve-local.sh 0xIL_TUO_INDIRIZZO"}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RPC=http://127.0.0.1:8545; CHAIN=46630
DEV=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; V3F=0x1f7d7550B1b028f7571E69A784071F0205FD2EfA; NPM=0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3
FACT=0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b; RH4=0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B; ROUTER=0xCaF681a66D020601342297493863E78C959E5cB2
PM=0x8366a39CC670B4001A1121B8F6A443A643e40951; HOOK=0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044; USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
SITE=$(mktemp -d /tmp/rh4-curve-XXXX)
cleanup() { echo; echo "spengo fork e sito…"; kill $ANVIL $HTTP 2>/dev/null; rm -rf "$SITE"; }
trap cleanup EXIT

echo "1/4 fork locale di Robinhood Chain…"
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id $CHAIN --port 8545 --block-time 2 --auto-impersonate --silent &
ANVIL=$!
for i in $(seq 1 30); do cast block-number --rpc-url $RPC >/dev/null 2>&1 && break; sleep 1; done
cast block-number --rpc-url $RPC >/dev/null 2>&1 || { echo "il fork non parte (RPC pubblico bloccato?): riprova fra un po'"; exit 1; }
cast rpc anvil_setBalance $DEV 0xC9F2C9CD04674EDEA40000000 --rpc-url $RPC >/dev/null
cast rpc anvil_setBalance "$ME" 0x56BC75E2D63100000 --rpc-url $RPC >/dev/null     # 100 ETH finti a te

echo "2/4 deploy della curva e del vault…"
cd "$ROOT"
U="--rpc-url $RPC --from $DEV --unlocked"
BC=$(forge inspect src/curve/RH4Curve.sol:RH4Curve bytecode 2>/dev/null)
ARGS=$(cast abi-encode "c(address,address,address,address)" $WETH $V3F $NPM $DEV)
CURVE=$(cast send $U --create "${BC}${ARGS#0x}" 2>&1 | grep contractAddress | awk '{print $2}')
BC=$(forge inspect src/curve/CurveFeeVault.sol:CurveFeeVault bytecode 2>/dev/null)
ARGS=$(cast abi-encode "c(address,address,address,address,address,address,address,address,address)" $NPM $FACT $RH4 $WETH $ROUTER $PM $HOOK $CURVE $DEV)
VAULT=$(cast send $U --create "${BC}${ARGS#0x}" 2>&1 | grep contractAddress | awk '{print $2}')
cast send $CURVE "setFeeVault(address)" $VAULT $U >/dev/null
cast send $CURVE "setQuote(address,bool,uint256)" $WETH true 10000000000000000 $U >/dev/null    # min 0.01 ETH
cast send $CURVE "setQuote(address,bool,uint256)" $USDG true 100000000 $U >/dev/null            # min 100 USDG

echo "3/4 due lanci di prova…"
cast send $CURVE "launch(string,string,address,uint256,uint16)" "Fork Meme" "FMEME" $WETH 4200000000000000000 5000 $U >/dev/null
cast send $CURVE "launch(string,string,address,uint256,uint16)" "Tiny One" "TINY" $WETH 50000000000000000 0 $U >/dev/null
cast rpc anvil_mine 0x66 --rpc-url $RPC >/dev/null
T0=$(cast call $CURVE "tokens(uint256)(address)" 0 --rpc-url $RPC); T1=$(cast call $CURVE "tokens(uint256)(address)" 1 --rpc-url $RPC)
cast send $CURVE "buy(address,uint256,uint256)" $T0 0 0 --value 1ether $U >/dev/null
cast send $CURVE "buy(address,uint256,uint256)" $T1 0 0 --value 0.2ether $U >/dev/null          # TINY gradua

echo "4/4 il sito, con la curva accesa…"
cp -r docs/. "$SITE"/
python3 - "$SITE" "$CURVE" "$VAULT" "$CHAIN" <<'PY'
import sys,re
site,curve,vault,chain=sys.argv[1:]
p=site+'/config.js'; s=open(p).read()
s=s.replace('rpc: "https://rpc.mainnet.chain.robinhood.com"','rpc: "http://127.0.0.1:8545"')
s=s.replace('chainId: 4663,',f'chainId: {chain},').replace('chainIdHex: "0x1237",',f'chainIdHex: "{hex(int(chain))}",').replace('chainName: "Robinhood Chain",','chainName: "Robinhood Chain (local fork)",')
s=re.sub(r'curve: \{ address: "[^"]*", vault: "[^"]*", enabled: \w+ \}', f'curve: {{ address: "{curve}", vault: "{vault}", enabled: true }}', s)
open(p,'w').write(s)
PY
python3 -m http.server 8124 --directory "$SITE" >/dev/null 2>&1 &
HTTP=$!

cat <<MSG

  pronto.
  curva  $CURVE
  vault  $VAULT
  tu     $ME  (100 ETH finti)

  apri  http://localhost:8124/curve.html  nel browser col wallet.
  al primo LAUNCH o BUY il wallet chiede di aggiungere la rete
  "Robinhood Chain (local fork)" (chain id $CHAIN, RPC 127.0.0.1:8545): accetta.
  e' una rete finta: niente di quello che firmi qui tocca la chain vera.

  Ctrl+C per spegnere tutto.
MSG
wait $ANVIL
