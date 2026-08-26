// ---------------------------------------------------------------------------
// RH-8 — il processore che si puo' usare.
//
// La RH-4 girava da sola e basta: niente ingressi, niente memoria, quattro
// bit. Un oggetto, non uno strumento. Questa cambia le tre cose insieme.
//
//   8 bit          numeri fino a 255 invece che fino a 15
//   ingresso       chi chiama tick() passa un byte, il programma lo legge
//   RAM            256 byte, che restano fra un ciclo e l'altro
//
// ---------------------------------------------------------------------------
//  Cosa NON sta dentro la netlist, e perche'
// ---------------------------------------------------------------------------
// ROM e RAM restano fuori, nello storage del contratto. La ROM lo era gia';
// la RAM lo diventa per la stessa ragione, moltiplicata: 256 byte come
// flip-flop sarebbero 2.048 porte in piu' per tenere dati che lo storage
// tiene meglio e a meno.
//
// Il processore espone indirizzo e dato, il contratto fa l'accesso vero. In
// gate costa zero.
//
// ---------------------------------------------------------------------------
//  Perche' una LD prende due cicli
// ---------------------------------------------------------------------------
// Il contratto deve sapere QUALE indirizzo leggere prima di far girare i
// gate, ma l'indirizzo lo decide un registro che solo i gate sanno leggere.
// Se ne esce come nel silicio vero: l'indirizzo si latcha in un ciclo e il
// dato arriva nel successivo. Una load costa due colpi di clock, esattamente
// come su un processore vero.
// ---------------------------------------------------------------------------

`default_nettype none

module rh8 (
    input  wire        clk,
    input  wire [24:0] instr,     // ROM[pc], gia' letta dal contratto
    input  wire  [7:0] in_port,   // il byte passato a tick()
    input  wire  [7:0] ram_rdata, // RAM[ram_addr] del ciclo precedente

    output wire  [9:0] pc_o,
    output wire  [7:0] out_o,
    output wire  [7:0] ram_addr_o,
    output wire  [7:0] ram_wdata_o,
    output wire        ram_we_o,
    output wire        halt_o
);

  // ---- opcode: 5 bit, 32 posti, 29 usati ----
  localparam [4:0]
    OP_NOP  = 5'd0,   OP_LDI  = 5'd1,   OP_MOV  = 5'd2,   OP_ADD  = 5'd3,
    OP_ADC  = 5'd4,   OP_SUB  = 5'd5,   OP_SBB  = 5'd6,   OP_AND  = 5'd7,
    OP_OR   = 5'd8,   OP_XOR  = 5'd9,   OP_NAND = 5'd10,  OP_NOT  = 5'd11,
    OP_SHL  = 5'd12,  OP_SHR  = 5'd13,  OP_ROL  = 5'd14,  OP_ROR  = 5'd15,
    OP_INC  = 5'd16,  OP_DEC  = 5'd17,  OP_CMP  = 5'd18,  OP_LD   = 5'd19,
    OP_ST   = 5'd20,  OP_IN   = 5'd21,  OP_OUT  = 5'd22,  OP_JMP  = 5'd23,
    OP_JZ   = 5'd24,  OP_JNZ  = 5'd25,  OP_JC   = 5'd26,  OP_JNC  = 5'd27,
    OP_HLT  = 5'd28;

  // formato: [24:20] opcode  [19:16] rd  [15:12] rs  [11:0] imm/addr
  wire [4:0] op   = instr[24:20];
  wire [3:0] rd   = instr[19:16];
  wire [3:0] rs   = instr[15:12];
  wire [7:0] imm  = instr[7:0];
  wire [9:0] addr = instr[9:0];

  // ---- stato architetturale ----
  reg [7:0] regs [0:15];   // 128 FF — register file
  reg [9:0] pc;            //  10
  reg       cf;            //   1
  reg       zf;            //   1
  reg [7:0] outr;          //   8
  reg       halted;        //   1
  reg [7:0] ram_addr;      //   8 — latchato, il contratto legge qui
  reg [7:0] ram_wdata;     //   8
  reg       ram_we;        //   1
  reg       ld_pending;    //   1 — c'e' una load da completare
  reg [3:0] ld_rd;         //   4 — dove va a finire
                           // ---- 171 flip-flop

  integer k;
  initial begin
    for (k = 0; k < 16; k = k + 1) regs[k] = 8'd0;
    pc = 10'd0; cf = 1'b0; zf = 1'b0; outr = 8'd0; halted = 1'b0;
    ram_addr = 8'd0; ram_wdata = 8'd0; ram_we = 1'b0;
    ld_pending = 1'b0; ld_rd = 4'd0;
  end

  wire [7:0] a = regs[rd];
  wire [7:0] b = regs[rs];

  // ---- ALU ----
  reg [8:0] alu;      // {carry, risultato}
  reg       alu_we;
  reg       flags_we;

  always @* begin
    alu = 9'd0;
    alu_we = 1'b0;
    flags_we = 1'b0;
    case (op)
      OP_LDI:  begin alu = {1'b0, imm};              alu_we = 1'b1;                  end
      OP_MOV:  begin alu = {1'b0, b};                alu_we = 1'b1;                  end
      OP_ADD:  begin alu = a + b;                    alu_we = 1'b1; flags_we = 1'b1; end
      OP_ADC:  begin alu = a + b + {8'd0, cf};       alu_we = 1'b1; flags_we = 1'b1; end
      OP_SUB:  begin alu = a - b;                    alu_we = 1'b1; flags_we = 1'b1; end
      OP_SBB:  begin alu = a - b - {8'd0, cf};       alu_we = 1'b1; flags_we = 1'b1; end
      OP_AND:  begin alu = {1'b0, a & b};            alu_we = 1'b1; flags_we = 1'b1; end
      OP_OR:   begin alu = {1'b0, a | b};            alu_we = 1'b1; flags_we = 1'b1; end
      OP_XOR:  begin alu = {1'b0, a ^ b};            alu_we = 1'b1; flags_we = 1'b1; end
      OP_NAND: begin alu = {1'b0, ~(a & b)};         alu_we = 1'b1; flags_we = 1'b1; end
      OP_NOT:  begin alu = {1'b0, ~a};               alu_we = 1'b1; flags_we = 1'b1; end
      OP_SHL:  begin alu = {a, 1'b0};                alu_we = 1'b1; flags_we = 1'b1; end
      OP_SHR:  begin alu = {a[0], 1'b0, a[7:1]};     alu_we = 1'b1; flags_we = 1'b1; end
      OP_ROL:  begin alu = {a, cf};                  alu_we = 1'b1; flags_we = 1'b1; end
      OP_ROR:  begin alu = {a[0], cf, a[7:1]};       alu_we = 1'b1; flags_we = 1'b1; end
      OP_INC:  begin alu = a + 9'd1;                 alu_we = 1'b1; flags_we = 1'b1; end
      OP_DEC:  begin alu = a - 9'd1;                 alu_we = 1'b1; flags_we = 1'b1; end
      // CMP mette solo i flag: serve a decidere senza distruggere rd
      OP_CMP:  begin alu = a - b;                                   flags_we = 1'b1; end
      OP_IN:   begin alu = {1'b0, in_port};          alu_we = 1'b1;                  end
      default: ;
    endcase
  end

  // ---- salti ----
  wire take = (op == OP_JMP)
           || (op == OP_JZ  &&  zf)
           || (op == OP_JNZ && ~zf)
           || (op == OP_JC  &&  cf)
           || (op == OP_JNC && ~cf);

  wire is_hlt = (op == OP_HLT);
  wire is_out = (op == OP_OUT);
  wire is_ld  = (op == OP_LD);
  wire is_st  = (op == OP_ST);

  // ---- fronte di salita = un blocco ----
  always @(posedge clk) begin
    if (~halted) begin
      if (is_hlt) begin
        halted <= 1'b1;
      end else begin
        pc <= take ? addr : pc + 10'd1;
      end

      // La load del ciclo scorso si chiude adesso: il dato e' arrivato.
      // Ha la precedenza sulla ALU perche' e' cominciata prima.
      if (ld_pending) regs[ld_rd] <= ram_rdata;
      else if (alu_we) regs[rd] <= alu[7:0];

      if (flags_we) begin
        cf <= alu[8];
        zf <= ~|alu[7:0];
      end
      if (is_out) outr <= a;

      // accessi alla memoria: si latcha adesso, il contratto esegue dopo
      ld_pending <= is_ld;
      ld_rd      <= rd;
      ram_we     <= is_st;
      ram_addr   <= is_ld ? b : (is_st ? a : 8'd0);
      ram_wdata  <= b;
    end
  end

  assign pc_o        = pc;
  assign out_o       = outr;
  assign ram_addr_o  = ram_addr;
  assign ram_wdata_o = ram_wdata;
  assign ram_we_o    = ram_we;
  assign halt_o      = halted;

endmodule

`default_nettype wire
