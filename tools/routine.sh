#!/bin/bash
# routine.sh — il giro completo del keeper, in un comando.
#
#   bash tools/routine.sh            il giro di ogni giorno
#   bash tools/routine.sh --epoch    ...piu' l'epoca settimanale dei dividendi RH4 (snapshot, publish, push)
#   bash tools/routine.sh --dry-run  racconta, non manda
#
# Chiede una volta la password del keystore rh4-keeper2 e passa la chiave ai
# tool solo nell'ambiente di questo processo: mai su riga di comando, mai in chat.
#
# Passi, nell'ordine:
#   1. guard.js      spegne i chip agganciati a token estranei
#   2. sweep.js      riscuote le fee di tutti i vault, converte le quote, ricompra RH4
#   3. dividend.js   round: ETH delle fee della madre -> azioni per gli holder + buyback
#   4. holders.js    round: fee dei chip HOLDERS -> snapshot, epoca, push
#   5. (--epoch)     dividendi RH4: snapshot dell'epoca successiva, publish, push
set -e
cd "$(dirname "$0")/.."
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
DRY=""; EPOCH=""
for a in "$@"; do case "$a" in --dry-run) DRY="--dry-run";; --epoch) EPOCH=1;; esac; done
if [ -z "$PRIVATE_KEY" ]; then
  export PRIVATE_KEY=0x$(cast wallet decrypt-keystore rh4-keeper2 | grep -oiE '[0-9a-f]{64}' | tail -1)
fi
trap 'unset PRIVATE_KEY' EXIT
KEEPER=$(cast wallet address --private-key $PRIVATE_KEY)
echo "== keeper $KEEPER · $(cast balance $KEEPER --rpc-url https://rpc.mainnet.chain.robinhood.com --ether) ETH · $(date -u +%FT%TZ)"

echo; echo "== 1/4 guardia"
node tools/guard.js $DRY
echo; echo "== 2/4 sweep dei vault"
node tools/sweep.js $DRY
echo; echo "== 3/4 dividendi: round"
node tools/dividend.js round $DRY
echo; echo "== 4/4 fee dei chip HOLDERS: round"
node tools/holders.js round $DRY
# i vault holders di prima (con le loro posizioni), ognuno con la sua cartella di epoche
node -e "const c=require('./tools/chain.js').siteConfig(); for (const h of c.holdersVaultsLegacy||[]) console.log(h.vault, h.path)" | while read V P; do
  echo "   -- vault di prima $V"; node tools/holders.js round $DRY --vault $V --out docs/$P
done

if [ -n "$EPOCH" ]; then
  echo; echo "== 5/5 epoca dividendi RH4"
  N=$(cast call $(node -e "const vm=require('vm'),fs=require('fs');const sb={window:{}};vm.runInNewContext(fs.readFileSync('docs/config.js','utf8'),sb);console.log(sb.window.RH4_CONFIG.stockVault)") "epochCount()(uint256)" --rpc-url https://rpc.mainnet.chain.robinhood.com)
  echo "   prossima epoca: $N"
  if [ -n "$DRY" ]; then echo "   [dry] snapshot --epoch $N, publish, push"; else
    node tools/snapshot.js --epoch $N
    node tools/dividend.js publish --file docs/dividends/epoch-$N.json
    node tools/dividend.js push --epoch $N
    echo "   ricorda: git add docs/dividends && git commit && git push (cosi' il profilo vede l'epoca)"
  fi
fi
echo; echo "== giro finito · keeper $(cast balance $KEEPER --rpc-url https://rpc.mainnet.chain.robinhood.com --ether) ETH"
