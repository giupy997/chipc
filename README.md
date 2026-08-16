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
`npm install` e `forge install foundry-rs/forge-std --no-git`.

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
src/RH4.sol          il contratto: clock, ROM, eventi
test/RH4.t.sol       prova end-to-end contro la sequenza dell'RTL
```

`src/RH4Gates.sol` è generato: non va toccato a mano. Si rigenera con
`make gates` ogni volta che cambia `rtl/rh4.v`.

La catena di verifica ha tre anelli e tutti e tre devono dire la stessa cosa,
**ciclo per ciclo**: simulazione RTL (iverilog) → simulazione della netlist
sintetizzata (`netsim.js`) → esecuzione dentro l'EVM (`forge test`). Il test
Solidity non verifica il contratto contro se stesso: verifica che il contratto
si comporti come l'hardware.
