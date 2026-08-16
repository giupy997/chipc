// ---------------------------------------------------------------------------
// RH-4 — CPU 4-bit, ISA nostra, pensata per girare gate-level dentro l'EVM.
//
// Un ciclo di clock = un blocco della Robinhood Chain (~100 ms) = 1 istruzione.
// Single-cycle: niente FSM fetch/decode/execute, ogni istruzione si completa
// in un colpo di clock. Il clock non e' un oscillatore, e' la chain.
//
// La ROM sta FUORI dalla netlist: il wrapper Solidity legge ROM[pc] e la
// presenta su `instr`. Costa zero gate e rende il programma sostituibile
// senza risintetizzare il processore.
//
// Formato istruzione — 12 bit:
//     [11:8] opcode
//     [7:4]  rd   (registro destinazione / sorgente per OUT)
//     [3:0]  rs   (registro sorgente, oppure immediato a 4 bit per LDI)
//     [7:0]  addr (campo unico per i salti: rd e rs concatenati)
//
// Nessun reset: lo stato di reset e' "tutti zeri", che e' esattamente come
// nasce una bitmap in storage. Un port di reset sarebbe solo gate sprecati.
// ---------------------------------------------------------------------------

`default_nettype none

module rh4 (
    input  wire        clk,
    input  wire [11:0] instr,   // ROM[pc], fornita dall'esterno
    output wire [7:0]  pc_o,
    output wire [3:0]  out_o,
    output wire        halt_o
);

  // ---- opcode ----
  localparam [3:0] OP_NOP  = 4'h0;  // niente
  localparam [3:0] OP_LDI  = 4'h1;  // rd <- imm4
  localparam [3:0] OP_MOV  = 4'h2;  // rd <- rs
  localparam [3:0] OP_ADD  = 4'h3;  // rd <- rd + rs
  localparam [3:0] OP_ADC  = 4'h4;  // rd <- rd + rs + C
  localparam [3:0] OP_SUB  = 4'h5;  // rd <- rd - rs      (C = borrow)
  localparam [3:0] OP_NAND = 4'h6;  // rd <- ~(rd & rs)
  localparam [3:0] OP_XOR  = 4'h7;  // rd <- rd ^ rs
  localparam [3:0] OP_SHR  = 4'h8;  // rd <- rd >> 1      (C = bit espulso)
  localparam [3:0] OP_INC  = 4'h9;  // rd <- rd + 1
  localparam [3:0] OP_JMP  = 4'hA;  // pc <- addr
  localparam [3:0] OP_JZ   = 4'hB;  // se Z: pc <- addr
  localparam [3:0] OP_JC   = 4'hC;  // se C: pc <- addr
  localparam [3:0] OP_JNZ  = 4'hD;  // se !Z: pc <- addr
  localparam [3:0] OP_OUT  = 4'hE;  // porta di uscita <- rd
  localparam [3:0] OP_HLT  = 4'hF;  // ferma il processore

  wire [3:0] op   = instr[11:8];
  wire [3:0] rd   = instr[7:4];
  wire [3:0] rs   = instr[3:0];
  wire [7:0] addr = instr[7:0];

  // ---- stato architetturale (tutti i flip-flop del design) ----
  reg [3:0] regs [0:15];   // 64 FF — register file
  reg [7:0] pc;            //  8 FF
  reg       cf;            //  1 FF — carry / borrow
  reg       zf;            //  1 FF — zero
  reg [3:0] outr;          //  4 FF — porta di uscita, latchata
  reg       halted;        //  1 FF
                           // ------ 79 flip-flop in totale

  integer k;
  initial begin
    for (k = 0; k < 16; k = k + 1) regs[k] = 4'd0;
    pc     = 8'd0;
    cf     = 1'b0;
    zf     = 1'b0;
    outr   = 4'd0;
    halted = 1'b0;
  end

  // due porte di lettura combinatorie sul register file
  wire [3:0] a = regs[rd];
  wire [3:0] b = regs[rs];

  // ---- ALU ----
  // alu[4] = carry uscente, alu[3:0] = risultato
  reg [4:0] alu;
  reg       alu_we;    // scrivi il risultato in rd
  reg       flags_we;  // aggiorna C e Z

  always @* begin
    alu      = 5'd0;
    alu_we   = 1'b0;
    flags_we = 1'b0;
    case (op)
      OP_LDI:  begin alu = {1'b0, rs};           alu_we = 1'b1;                   end
      OP_MOV:  begin alu = {1'b0, b};            alu_we = 1'b1;                   end
      OP_ADD:  begin alu = a + b;                alu_we = 1'b1; flags_we = 1'b1;  end
      OP_ADC:  begin alu = a + b + {4'd0, cf};   alu_we = 1'b1; flags_we = 1'b1;  end
      OP_SUB:  begin alu = a - b;                alu_we = 1'b1; flags_we = 1'b1;  end
      OP_NAND: begin alu = {1'b0, ~(a & b)};     alu_we = 1'b1; flags_we = 1'b1;  end
      OP_XOR:  begin alu = {1'b0, a ^ b};        alu_we = 1'b1; flags_we = 1'b1;  end
      OP_SHR:  begin alu = {a[0], 1'b0, a[3:1]}; alu_we = 1'b1; flags_we = 1'b1;  end
      OP_INC:  begin alu = a + 5'd1;             alu_we = 1'b1; flags_we = 1'b1;  end
      default: ;
    endcase
  end

  // ---- salti ----
  wire take = (op == OP_JMP)
           || (op == OP_JZ  &&  zf)
           || (op == OP_JNZ && ~zf)
           || (op == OP_JC  &&  cf);

  wire is_hlt = (op == OP_HLT);
  wire is_out = (op == OP_OUT);

  // ---- fronte di salita = nuovo blocco ----
  always @(posedge clk) begin
    if (~halted) begin
      if (is_hlt) begin
        halted <= 1'b1;
      end else begin
        pc <= take ? addr : pc + 8'd1;
      end

      if (alu_we)   regs[rd] <= alu[3:0];
      if (flags_we) begin
        cf <= alu[4];
        zf <= ~|alu[3:0];
      end
      if (is_out)   outr <= a;
    end
  end

  assign pc_o   = pc;
  assign out_o  = outr;
  assign halt_o = halted;

endmodule

`default_nettype wire
