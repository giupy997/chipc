# RH-4 — un processore 4-bit che gira dentro la Robinhood Chain

Un vero processore descritto in Verilog, sintetizzato a **soli NAND e flip-flop**,
destinato a essere eseguito gate per gate dentro un contratto sulla Robinhood Chain.
Nessuna emulazione: il contratto valuta 1.029 porte NAND a ogni ciclo.

Il clock non è un oscillatore. **Un blocco = un colpo di clock.**
Robinhood Chain fa un blocco ogni ~100 ms → il processore gira a **~10 Hz**.

## Stato

| fase | stato |
|---|---|
| ISA + RTL Verilog | fatto |
| assembler | fatto |
| simulazione RTL | fatto — Fibonacci OK in 49 cicli |
| sintesi NAND + DFF | fatto — 1.029 NAND, 79 flip-flop |
| simulazione gate-level | fatto — identica all'RTL, ciclo per ciclo |
| codegen Yul | fatto — 1.029 gate srotolati |
| contratto + test | fatto — 18.192 byte, 60k gas/ciclo, Fibonacci OK on-chain |
| programma di mainnet | fatto — `forever.asm`, periodo 8,7 minuti, mai un HLT |
| keeper | fatto — 10,04 Hz misurati su anvil a 100 ms |
| sito | fatto — `docs/`, il processore gira nel browser |
| fabbrica di chip | fatto — ERC-721, SVG on-chain, token per chip, chip madre, 37 test |
| deploy in mainnet | da fare |

```bash
make sim               # simulazione RTL (iverilog)
make synth             # sintesi a NAND + flip-flop (yosys)
make gatesim           # netlist sintetizzata su Fibonacci
make gatesim-forever   # netlist sintetizzata sul programma di mainnet
make gates             # netlist -> src/RH4Gates.sol (Yul srotolato)
make evm               # compila il contratto e lo prova end-to-end (forge)
make                   # tutto in fila
```

Serve `brew install yosys icarus-verilog`, [foundry](https://getfoundry.sh),
`npm install`, `forge install foundry-rs/forge-std --no-git` e
`forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git`.

## Il sito

`docs/` è il sito, servito da GitHub Pages. Non è un video del processore: è il
processore. `tools/webgen.js` impacchetta la stessa netlist che gira dentro
l'EVM — 1.029 NAND in ordine topologico — e il browser di chi guarda la esegue
gate per gate, a 10 Hz come la chain.

```bash
make site                  # rigenera docs/rh4-data.js dalla netlist
python3 -m http.server -d docs 8123
```

Il pannello mostra la porta di uscita, i 16 registri, il PC che cammina sul
listato e "il die": un quadrato per NAND, che si accende quando la sua uscita
commuta.

## ISA

Parola di istruzione da **12 bit**, esecuzione **single-cycle**: ogni istruzione
si completa in un blocco.

```
 [11:8] opcode   [7:4] rd   [3:0] rs        (rs = immediato a 4 bit per LDI)
 [11:8] opcode   [7:0] addr                 (per i salti)
```

| op | mnemonico | effetto | flag |
|----|-----------|---------|------|
| 0 | `nop` | — | |
| 1 | `ldi rd, #imm` | `rd ← imm` | |
| 2 | `mov rd, rs` | `rd ← rs` | |
| 3 | `add rd, rs` | `rd ← rd + rs` | C Z |
| 4 | `adc rd, rs` | `rd ← rd + rs + C` | C Z |
| 5 | `sub rd, rs` | `rd ← rd − rs` | C=borrow, Z |
| 6 | `nand rd, rs` | `rd ← ~(rd & rs)` | Z |
| 7 | `xor rd, rs` | `rd ← rd ^ rs` | Z |
| 8 | `shr rd` | `rd ← rd >> 1` | C=bit espulso, Z |
| 9 | `inc rd` | `rd ← rd + 1` | C Z |
| A | `jmp addr` | `pc ← addr` | |
| B | `jz addr` | se Z: `pc ← addr` | |
| C | `jc addr` | se C: `pc ← addr` | |
| D | `jnz addr` | se ¬Z: `pc ← addr` | |
| E | `out rd` | porta di uscita ← `rd` | |
| F | `hlt` | ferma il processore | |

16 registri da 4 bit (`r0`–`r15`), PC a 8 bit, ROM da 256 parole.

## Le due scelte che contano

**La ROM sta fuori dalla netlist.** Il processore riceve `instr` già letta; è il
contratto a fare `ROM[pc]`. Costa zero gate e rende il programma sostituibile
senza risintetizzare nulla.

**Niente reset.** Lo stato di reset è "tutti zeri", che è già come nasce una
bitmap in storage. Un port di reset sarebbe solo gate e routing sprecati.

## Perché lo stato entra in uno slot

Tutti i flip-flop del design:

```
 register file  16 × 4 bit   64
 pc                           8
 porta di uscita              4
 carry, zero, halted          3
 ───────────────────────────────
                             79 bit
```

**79 bit → un singolo slot di storage da 256 bit.** L'intero stato architetturale
del processore è una `SSTORE` per ciclo. È il motivo per cui il costo per tick
resta basso nonostante si valutino mille porte logiche.

## Dentro l'EVM

Ogni net del processore è una parola di memoria da 32 byte con dentro uno 0 o
un 1. Sprecone sui bit, ma un `mload` costa 3 gas e non serve nessuno shift per
isolare il bit: sui 1.029 gate è il compromesso che vince.

Un NAND diventa una riga sola:

```
mstore(0x1a40, iszero(and(mload(0x0c60), mload(0x1220))))
```

I flip-flop invece non esistono come codice. A inizio ciclo la parola di stato
si spalma sui net delle Q, a fine ciclo si ricampionano tutte le D e si
ricompone la parola: i flop commutano insieme, come nel silicio.

**Nell'EVM non c'è propagazione, c'è una sequenza.** Per questo `netlist.js`
ordina i gate topologicamente prima che `codegen.js` li emetta.

### Numeri misurati

| | |
|---|---|
| bytecode runtime | **18.192 byte** (margine 6.384 sul limite di 24.576) |
| gas per ciclo | **~60.100** (39.088 di esecuzione + 21.000 di base tx) |
| slot di storage toccati per ciclo | 1 letto, 1 scritto |

Un contratto solo, niente split in bank via `delegatecall`.

### Costo del clock

A 0,0202 gwei sulla Robinhood Chain, un ciclo costa ~1,21e-6 ETH.

| ritmo | costo |
|---|---|
| Fibonacci intero (49 cicli) | ~0,00006 ETH |
| 1 Hz, un giorno | ~0,10 ETH |
| 10 Hz (ogni blocco), un giorno | ~1,05 ETH |

Per questo `tick()` è permissionless e chi lo chiama paga: il clock si
autofinanzia e lo sponsor di ogni ciclo resta scritto nell'evento `Cycle`.

## Il programma che gira in mainnet

[`asm/forever.asm`](asm/forever.asm) non contiene `hlt`, e non può contenerlo:
se la RH-4 si ferma, si ferma per sempre — solo l'operatore può resettarla.
Tre movimenti in loop, tutti leggibili sulle 4 uscite:

| movimento | uscita | durata |
|---|---|---|
| scanner | `1 2 4 8 8 4 2 1`, un bit che rimbalza | 16 rimbalzi |
| contatore | `0 1 2 … 14 15`, in salita | 16 passaggi |
| rumore | LFSR a 4 bit, `1 2 4 9 3 6 13 10 5 …` | 256 uscite |

L'LFSR ha prese sui bit 3 e 2 (x⁴+x³+1): periodo 15, passa per tutti i valori
tranne lo zero. Lo zero è l'unico stato assorbente e non viene mai raggiunto,
quindi il rumore non si spegne.

**Periodo dell'intero programma: 5.238 cicli, cioè 8,7 minuti a 10 Hz.**

Il rischio vero non è un bug di calcolo, è un `hlt` accidentale: per questo
`make gatesim-forever` gira 20.000 cicli sulla netlist e `test_foreverNonSiFermaMai`
ne gira 5.300 dentro l'EVM, entrambi pretendendo che il processore non si fermi.

## Il clock

`tick()` è aperto a chiunque. Il keeper non ha nessun diritto speciale: è solo
il primo a pagare. Se un altro sponsor tocca il clock nello stesso blocco la
nostra transazione fallisce — ed è esattamente ciò che deve succedere, quel
ciclo l'ha pagato lui.

```bash
export PRIVATE_KEY=0x…                        # mai in chat, mai da riga di comando
node tools/deploy.js --program build/forever.slots.json
RH4_ADDRESS=0x… node tools/keeper.js --budget 0.01
```

Il keeper si ferma da solo su `--budget` (ETH), `--cycles`, o se il processore
incontra un `hlt`. Il tetto di spesa non è un vezzo: a 10 Hz continui il clock
brucia circa 1 ETH al giorno, e un keeper senza budget lasciato acceso è un
rubinetto aperto.

Misurato contro anvil configurato come la chain vera (blocchi da 100 ms):

```
  cicli portati a casa   80
  persi (altro sponsor)  0
  frequenza tenuta       10.04 Hz
```

Un blocco, un ciclo. Ci sono voluti due accorgimenti per arrivarci: il polling
di viem è a 4 secondi di default (quaranta blocchi persi per tick), e lo stato
nuovo si legge dall'evento `Cycle` dentro la ricevuta invece di richiamare
`inspect()`. Con tre round-trip per ciclo si stava a 5 Hz.

## La fabbrica di chip

Una RH-4 che sta per conto suo costa **4.091.584 gas** di deploy, perche' si
porta dietro i 18 kB dei gate srotolati. Farne una per utente sarebbe assurdo.

Quindi il silicio si deploya **una volta sola per tutta la chain**:

```
RH4GateArray     16,7 kB   le 1.029 NAND. `pure`, senza stato, senza padrone.
   ^
   | staticcall
   |
ChipFactory       9,4 kB   ERC-721. Ogni chip: 79 bit di stato + la sua ROM.
ChipRenderer      6,6 kB   l'SVG dell'NFT, disegnato dai bit veri.
```

Coniare un chip nudo costa **~250.000 gas** invece di 4,09 milioni: 16 volte
meno. Con il token integrato si sale a **822.987**, perche' si deploya anche un
ERC-20. Il prezzo per ciclo e' +1.301 gas per la staticcall al silicio (2%) e
~6.900 per pagare lo sponsor.

| | gas | su Robinhood Chain |
|---|---|---|
| deploy dell'intero stack, una volta | ~7,4 M | ~0,00015 ETH |
| coniare un chip + lanciare il token | 822.987 | ~0,0000166 ETH |
| coniare un chip nudo (token dopo) | ~250.000 | ~0,0000050 ETH |
| un ciclo di clock (paga lo sponsor) | 68.275 | ~0,0000014 ETH |

### Nome e sigla

Al conio si sceglie un **nome** (fino a 32 caratteri, libero) e una **sigla**
(1-8 caratteri fra `A-Z`, `0-9` e trattino). Sono due cose diverse: il nome e'
descrittivo, la sigla e' identita'.

**La sigla e' unica in tutta la fabbrica.** Senza unicita' chiunque potrebbe
coniare un chip con la sigla di un altro, ed e' un invito all'inganno. La
maiuscola e' obbligatoria per la stessa ragione: `BHMT` e `bhmt` non devono
poter convivere. `tickerAvailable(sigla)` dice gratis se e' libera.

Attenzione a una cosa che il vocabolario confonde: quella sigla e' **metadato
del chip**, non il simbolo di un ERC-20. Tutti i chip stanno nella stessa
collezione ERC-721 (`RH-4 Chip` / `CHIP`). Un chip non e' un token scambiabile
con una sua liquidita': e' un NFT con sopra scritta una sigla.

### Ogni chip ha il suo token, e i cicli sono l'unico modo di guadagnarlo

Al conio nasce un `ChipToken` con il nome e la sigla scelti: **offerta fissa,
un miliardo, e nessuna `mint`** — quel contratto non ha modo di stamparne
altri, ne' per l'operatore ne' per il proprietario del chip.

L'offerta si divide in due:

| | dove va |
|---|---|
| fetta di liquidita' (max 50%) | subito a chi conia, per farci il mercato |
| tutto il resto | resta alla fabbrica, esce **un ciclo alla volta** |

Non c'e' una seconda strada. A parte comprarli, **l'unico modo di ottenere i
token di un chip e' tenere acceso il suo processore**.

Ne segue la proprieta' che regge tutto:

> **Un chip gira alla velocita' che il mercato pensa che meriti.**

Se il token vale piu' del gas di un tick, qualcuno lo chiama e il processore
resta acceso. Se non vale, si ferma — ed e' l'esito onesto. L'emissione non e'
governata da nessuno: nessuno puo' stampare piu' in fretta di quanto la chain
chiuda i blocchi.

Quando la riserva finisce il clock **non** si ferma: continua gratis. Un chip
senza piu' token da distribuire e' ancora un processore acceso.

### Il chip madre

Il primo chip coniato e' anche il primo token del launchpad. `setMother(id)`
lo designa — **una volta sola**, perche' se il proprietario potesse spostarla
"madre" smetterebbe di voler dire qualcosa.

Da li' `setMintPriceToken(quota)` fa pagare il conio di ogni chip nuovo in
token della madre. E qui c'e' il punto, che esce gratis dall'architettura:

> La riserva di un chip **e'** il saldo che la fabbrica ha del suo token.

Quindi la quota di conio non finisce in tasca a nessuno: **allunga la vita del
clock della madre**, cioe' paga chi la tiene accesa. Coniare un chip nuovo
finanzia chi fa girare il primo.

La quota parte da zero: il conio resta libero finche' non la si accende.

⚠️ Da dire chiaro: se l'unico uso del token madre fosse coniare chip, e
l'unico uso dei chip fosse avere un token, sarebbe un giro chiuso. Il
contrappeso e' che ogni chip vale per conto suo — e' un processore vero, con
il suo token e i suoi sponsor — e la madre non e' l'unica fonte di valore.
Il meccanismo regge se i chip figli interessano a qualcuno; non li fa
interessare da solo.

### Token creato altrove (pools.trade e simili)

Un launchpad vuole creare il **proprio** contratto token: `UERC20Factory` non
creera' mai un `ChipToken`. Non serve che lo faccia. La fabbrica non ha bisogno
di *creare* il token, le basta sapere qual e' e avere una riserva da
distribuire.

```
mint(..., targetCycles: 0)     -> chip nudo, senza token
  ...lanci il token dove vuoi...
attachToken(id, token, reward) -> lo agganci
transfer(factory, riserva)     -> la riserva e' il saldo della fabbrica
```

Si aggancia **una volta sola**: se il proprietario potesse cambiare il token
dopo, chi ha macinato cicli per guadagnarlo si ritroverebbe in mano la cosa
sbagliata. E un token non puo' servire due chip, altrimenti si mangerebbero la
riserva a vicenda.

⚠️ Attenzione a `pools-launch/launch.js` cosi' com'e': passa
`amount: SUPPLY` alla strategy, cioe' manda **tutto** il miliardo nel pool.
Per finanziare i cicli va lasciata fuori una quota.

### Il clock e' la cosa scarsa, non il chip

Fabbricare un processore costa spiccioli. Tenerlo **acceso** no: un ciclo per
blocco, e ogni ciclo lo deve pagare qualcuno.

`tick(id)` e' aperto a chiunque — **non al proprietario, a chiunque** — e chi
paga resta inciso nell'evento `Cycle` come sponsor di quel ciclo. Un chip che
nessuno fa avanzare e' silicio morto in storage.

Il contatore dei cicli e' **monotono per tutta la vita del chip**: `restart()`
fa ripartire il processore ma non azzera quanto ha macinato. Altrimenti
"questo chip ha eseguito N cicli" non vorrebbe dire niente.

### L'NFT si disegna da solo

Niente IPFS, niente server: `tokenURI` costruisce un SVG a partire dai 79 bit
veri del processore. Le quattro luci sono la porta di uscita in quell'istante,
il conteggio e' quello che gli sponsor hanno pagato. **L'immagine cambia da
sola** — un chip fermo e un chip acceso non si somigliano.

Le etichette passano da un filtro: un chip chiamato `<script>` non puo'
iniettare markup dentro l'SVG.

### Provare prima di coniare

Un chip che incontra `hlt` si ferma per sempre, e resta un NFT morto.
`previewProgram(rom, n)` e' una `view`: via `eth_call` non costa niente e dice
se il programma si ferma, prima che qualcuno ci spenda dei soldi.

```bash
PRIVATE_KEY=0x... node tools/deploy-factory.js --dry-run
PRIVATE_KEY=0x... node tools/deploy-factory.js --mint build/forever.slots.json \
    --label "Behemoth" --ticker BHMT
RH4_FACTORY=0x... node tools/keeper.js --chip 1 --budget 0.01
```

## Struttura

```
rtl/rh4.v            il processore
asm/fib.asm          Fibonacci a 4 bit: 1 1 2 3 5 8 13
tools/asm.js         assembler → build/rom.hex + build/rom.json
tools/netlist.js     carica la netlist yosys, ordina i NAND topologicamente
asm/forever.asm      il programma di mainnet: non finisce mai
tools/netsim.js      simulatore gate-level (oracolo per il codegen)
tools/codegen.js     netlist → src/RH4Gates.sol
tools/deploy.js      mette il processore sulla chain
tools/keeper.js      tiene il clock
tools/chain.js       config della chain, chiave da PRIVATE_KEY
sim/tb_rh4.v         testbench RTL
synth/rh4.ys         script di sintesi
synth/not2nand.v     un NOT è un NAND con gli ingressi in corto
src/RH4Gates.sol     GENERATO — i 1.029 gate in Yul
src/RH4State.sol     GENERATO — dove stanno i bit dentro la parola di stato
src/RH4.sol          la RH-4 singola: clock, ROM, eventi
src/RH4GateArray.sol il silicio condiviso, uno per chain
src/ChipFactory.sol  la fabbrica: ERC-721 + clock permissionless
src/ChipRenderer.sol l'SVG degli NFT, on-chain
tools/deploy-factory.js  mette in piedi i tre contratti
tools/keeper.js      tiene acceso un processore (singolo o chip)
test/                22 test: RH-4 singola e fabbrica
```

`src/RH4Gates.sol` è generato: non va toccato a mano. Si rigenera con
`make gates` ogni volta che cambia `rtl/rh4.v`.

La catena di verifica ha tre anelli e tutti e tre devono dire la stessa cosa,
**ciclo per ciclo**: simulazione RTL (iverilog) → simulazione della netlist
sintetizzata (`netsim.js`) → esecuzione dentro l'EVM (`forge test`). Il test
Solidity non verifica il contratto contro se stesso: verifica che il contratto
si comporti come l'hardware.
