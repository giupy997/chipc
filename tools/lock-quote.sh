#!/bin/bash
# lock-quote.sh — occupa lo slot di una quota nella fabbrica prima che lo faccia un estraneo.
#
#   PRIVATE_KEY=0x... bash tools/lock-quote.sh <QUOTE> <TICKER> [RPC]
#   es.  bash tools/lock-quote.sh 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 LOCKWETH
#
# La fabbrica lascia agganciare a un chip senza token un ERC20 qualsiasi
# (attachToken): chi aggancia WETH si prende meta' delle fee di ogni posizione
# con WETH come token0 nei vault buyback v2, e il resto lo tira fuori dalla
# fabbrica con un tick. Qui il team aggancia la quota a un chip il cui
# programma e' un solo HLT: ricompensa 1 wei, il primo tick lo ferma per
# sempre, e chipByToken(quota) resta nostro. La quota che i vecchi vault
# mandano in fabbrica resta li' sepolta: meglio sepolta che rubata.
#
# Per WETH il wei di riserva si crea con deposit(); per un'azione il wallet
# deve averne almeno 1 wei. Tutto via cast: il simulatore di forge non digerisce
# la gate array.
set -e
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
QUOTE=${1:?quota}; TICKER=${2:?ticker}; RPC=${3:-https://rpc.mainnet.chain.robinhood.com}
: "${PRIVATE_KEY:?export PRIVATE_KEY=0x... (dal keystore, mai in chat)}"
F=0x265a4d74dbf6c10f40ecf7d870df7677cb6ff65b
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
ME=$(cast wallet address --private-key $PRIVATE_KEY)
[ "$(cast call $F 'chipByToken(address)(uint256)' $QUOTE --rpc-url $RPC)" = "0" ] || { echo "quota gia' agganciata a un chip"; exit 1; }
[ "$(cast code $ME --rpc-url $RPC)" = "0x" ] || { echo "il wallet $ME ha codice (delega 7702?): mint rifiuterebbe l'NFT"; exit 1; }
S="--rpc-url $RPC --private-key $PRIVATE_KEY"
if [ "$(echo $QUOTE | tr A-Z a-z)" = "$(echo $WETH | tr A-Z a-z)" ]; then cast send $WETH "deposit()" --value 1 $S >/dev/null; fi
cast send $QUOTE "transfer(address,uint256)" $F 1 $S >/dev/null
WORDS="[$(python3 -c "print(','.join(['29360128']+['0']*127))")]"     # ROM: HLT (opcode 28 << 20) e basta
PRICE=$(cast call $F "mintPrice()(uint256)" --rpc-url $RPC)
cast send $F "mint(uint256[128],bytes32,bytes32,string,uint16,uint64)" "$WORDS" $(cast --format-bytes32-string "quote lock") $(cast --format-bytes32-string "$TICKER") "" 0 0 --value $PRICE $S >/dev/null
ID=$(cast call $F "chipByTicker(bytes32)(uint256)" $(cast --format-bytes32-string "$TICKER") --rpc-url $RPC)
echo "chip #$ID coniato"
cast send $F "attachToken(uint256,address,uint96)" $ID $QUOTE 1 $S >/dev/null
echo "quota $QUOTE agganciata al chip #$ID (ricompensa 1 wei)"
cast send $F "tick(uint256,uint8)" $ID 0 --gas-limit 600000 $S >/dev/null
echo "primo tick: HLT eseguito, il chip e' fermo per sempre"
echo "chipByToken(quota) = $(cast call $F 'chipByToken(address)(uint256)' $QUOTE --rpc-url $RPC)"
cast call $F "tick(uint256,uint8)" $ID 0 --rpc-url $RPC >/dev/null 2>&1 && echo "ATTENZIONE: un secondo tick passerebbe" || echo "secondo tick rifiutato: ok"
