// tb_rh8.v — banco di prova della RH-8.
//
// ROM e RAM stanno qui perche' nel disegno vero stanno nel contratto: il
// processore non le contiene, le chiede. Questo banco fa esattamente cio'
// che fara' il Solidity a ogni blocco, nello stesso ordine.

`timescale 1ns / 1ps
`default_nettype none

module tb_rh8;

  reg         clk = 1'b0;
  reg  [24:0] instr;
  reg   [7:0] in_port;
  reg   [7:0] ram_rdata;

  wire  [9:0] pc;
  wire  [7:0] out;
  wire  [7:0] ram_addr;
  wire  [7:0] ram_wdata;
  wire        ram_we;
  wire        halt;

  rh8 dut (
      .clk(clk), .instr(instr), .in_port(in_port), .ram_rdata(ram_rdata),
      .pc_o(pc), .out_o(out), .ram_addr_o(ram_addr),
      .ram_wdata_o(ram_wdata), .ram_we_o(ram_we), .halt_o(halt)
  );

  reg [24:0] rom [0:1023];
  reg  [7:0] ram [0:255];

  integer i, cycles, seen;
  reg [7:0] expected [0:2];

  initial begin
    for (i = 0; i < 1024; i = i + 1) rom[i] = 25'd0;
    for (i = 0; i < 256; i = i + 1) ram[i] = 8'd0;

    // [24:20] op  [19:16] rd  [15:12] rs  [11:0] imm/addr
    rom[0]  = 25'h1500000; // IN   r0            byte dall'esterno
    rom[1]  = 25'h0110020; // LDI  r1, #0x20     indirizzo 32
    rom[2]  = 25'h1410000; // ST   [r1], r0      RAM[32] <- r0
    rom[3]  = 25'h0100000; // LDI  r0, #0        cancello r0
    rom[4]  = 25'h1321000; // LD   r2, [r1]      parte la load
    rom[5]  = 25'h0000000; // NOP                la load si chiude qui
    rom[6]  = 25'h1620000; // OUT  r2            deve uscire il byte di ingresso
    rom[7]  = 25'h01300C8; // LDI  r3, #200
    rom[8]  = 25'h0140064; // LDI  r4, #100
    rom[9]  = 25'h0334000; // ADD  r3, r4        300 -> 44 con carry
    rom[10] = 25'h1630000; // OUT  r3            deve uscire 44
    rom[11] = 25'h1A0000D; // JC   13            il carry deve esserci
    rom[12] = 25'h1C00000; // HLT                se ci arriva, il carry mancava
    rom[13] = 25'h01500FF; // LDI  r5, #255
    rom[14] = 25'h1650000; // OUT  r5            255: impossibile su 4 bit
    rom[15] = 25'h1C00000; // HLT

    expected[0] = 8'hA5;   // il byte che gli diamo in ingresso
    expected[1] = 8'd44;   // 300 troncato a 8 bit
    expected[2] = 8'd255;  // la prova che non e' piu' un 4 bit

    in_port = 8'hA5;
    cycles = 0;
    seen = 0;
  end

  // Cio' che il contratto fa PRIMA di valutare i gate: legge ROM[pc] e
  // RAM[ram_addr]. L'indirizzo e' quello latchato dal ciclo precedente —
  // e' esattamente per questo che una load prende due colpi di clock.
  always @* begin
    instr = rom[pc];
    ram_rdata = ram[ram_addr];
  end

  always #5 clk = ~clk;

  // Cio' che il contratto fa DOPO: se il processore ha alzato ram_we,
  // esegue la scrittura.
  always @(posedge clk) begin
    #1;
    if (ram_we) ram[ram_addr] = ram_wdata;
  end

  always @(posedge clk) begin
    if (~halt && instr[24:20] == 5'd22) begin
      if (seen < 3 && dut.regs[instr[19:16]] !== expected[seen]) begin
        $display("FALLITO  uscita %0d: atteso %0d, ottenuto %0d",
                 seen, expected[seen], dut.regs[instr[19:16]]);
        $finish;
      end
      $display("  ciclo %3d   OUT = %0d", cycles, dut.regs[instr[19:16]]);
      seen = seen + 1;
    end
  end

  initial begin
    $display("RH-8 — 8 bit, ingresso, RAM");

    while (~halt && cycles < 200) begin
      @(posedge clk);
      cycles = cycles + 1;
      #2;
    end

    if (~halt)      begin $display("FALLITO  nessun halt"); $finish; end
    if (seen != 3)  begin $display("FALLITO  %0d uscite invece di 3", seen); $finish; end
    if (pc != 10'd15) begin $display("FALLITO  fermo a pc=%0d invece che 15 (carry mancato?)", pc); $finish; end
    if (ram[8'h20] !== 8'hA5) begin
      $display("FALLITO  RAM[32] = %0d invece di 165", ram[8'h20]); $finish;
    end

    $display("OK  halt al ciclo %0d", cycles);
    $display("    RAM[32] = %0d, scritta e riletta dal programma", ram[8'h20]);
    $finish;
  end

endmodule

`default_nettype wire
