TOP  := rh4
PROG := forever

.PHONY: all rom sim synth gatesim gatesim-forever gates evm site deploy clean

all: sim gatesim gatesim-forever evm site

# ---- programmi ------------------------------------------------------------
# Un .asm produce tre file: l'hex per le simulazioni, il listato, e la ROM
# gia' impacchettata nei 16 slot che si aspetta il costruttore del contratto.
build/%.hex: asm/%.asm tools/asm.js
	@node tools/asm.js asm/$*.asm build/$*.hex

build/%.slots.json: build/%.hex
	@:

rom: build/$(PROG).hex

# ---- hardware -------------------------------------------------------------
# simulazione RTL, sempre su Fibonacci: e' il programma che finisce
sim: build/fib.hex rtl/$(TOP).v sim/tb_$(TOP).v
	@cp build/fib.hex build/rom.hex
	@iverilog -g2005 -o build/tb_$(TOP).vvp rtl/$(TOP).v sim/tb_$(TOP).v
	@vvp build/tb_$(TOP).vvp

# sintesi in NAND + flip-flop D
synth: build/$(TOP).json
build/$(TOP).json: rtl/$(TOP).v synth/$(TOP).ys synth/not2nand.v
	@yosys -q -s synth/$(TOP).ys
	@node -e 'const c=Object.values(require("./build/$(TOP).json").modules.$(TOP).cells); \
	  const t={}; for(const x of c) t[x.type]=(t[x.type]||0)+1; \
	  console.log("netlist:", Object.entries(t).map(([k,v])=>v+" "+k.replace(/\$$_|_$$/g,"")).join(", "))'

# la netlist sintetizzata deve dare la stessa sequenza dell'RTL, ciclo per ciclo
gatesim: build/$(TOP).json build/fib.hex
	@node tools/netsim.js build/$(TOP).json build/fib.hex --expect 1,1,2,3,5,8,13

# e il programma di mainnet non deve fermarsi mai
gatesim-forever: build/$(TOP).json build/forever.hex
	@node tools/netsim.js build/$(TOP).json build/forever.hex \
	  --cycles 20000 --no-halt --quiet

# ---- EVM ------------------------------------------------------------------
gates: src/RH4Gates.sol
src/RH4Gates.sol: build/$(TOP).json tools/codegen.js tools/netlist.js
	@node tools/codegen.js build/$(TOP).json src/RH4Gates.sol

evm: src/RH4Gates.sol build/fib.slots.json build/forever.slots.json
	@forge build --sizes 2>/dev/null | grep -E '^\| RH4 ' || forge build --sizes
	@forge test -vv

# ---- sito -----------------------------------------------------------------
# La stessa netlist dell'EVM, impacchettata per il browser di chi guarda.
site: docs/rh4-data.js
docs/rh4-data.js: build/$(TOP).json build/forever.hex build/fib.hex tools/webgen.js
	@node tools/webgen.js docs/rh4-data.js

# ---- catena ---------------------------------------------------------------
deploy: evm build/$(PROG).slots.json
	@node tools/deploy.js --program build/$(PROG).slots.json

clean:
	@rm -rf build out cache src/RH4Gates.sol
