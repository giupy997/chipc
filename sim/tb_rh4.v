// tb_rh4.v — banco di prova RTL. La ROM sta qui perche' nel design vero sta
// nel wrapper Solidity: il processore vede solo la parola gia' letta.

`timescale 1ns / 1ps
`default_nettype none

module tb_rh4;

  reg         clk = 1'b0;
  wire [7:0]  pc;
  wire [3:0]  out;
  wire        halt;

  reg  [11:0] rom [0:255];
  wire [11:0] instr = rom[pc];

  rh4 dut (
      .clk   (clk),
      .instr (instr),
      .pc_o  (pc),
      .out_o (out),
      .halt_o(halt)
  );

  integer i;
  integer cycles;
  integer emitted;
  reg [3:0] expected [0:6];

  initial begin
    for (i = 0; i < 256; i = i + 1) rom[i] = 12'h000;
    $readmemh("build/rom.hex", rom);

    // 1 1 2 3 5 8 13 — la stessa sequenza della demo su BNB
    expected[0] = 4'd1;  expected[1] = 4'd1;  expected[2] = 4'd2;
    expected[3] = 4'd3;  expected[4] = 4'd5;  expected[5] = 4'd8;
    expected[6] = 4'd13;
  end

  always #5 clk = ~clk;

  // Sul fronte di salita i registri hanno ancora il valore vecchio: e'
  // esattamente quello che la OUT sta per latchare.
  always @(posedge clk) begin
    if (~halt && instr[11:8] == 4'hE) begin
      if (emitted < 7 && dut.regs[instr[7:4]] !== expected[emitted]) begin
        $display("FALLITO  uscita %0d: atteso %0d, ottenuto %0d",
                 emitted, expected[emitted], dut.regs[instr[7:4]]);
        $finish;
      end
      $display("  ciclo %3d   OUT = %0d", cycles, dut.regs[instr[7:4]]);
      emitted = emitted + 1;
    end
  end

  initial begin
    cycles  = 0;
    emitted = 0;
    $display("RH-4 — Fibonacci a 4 bit");

    while (~halt && cycles < 500) begin
      @(posedge clk);
      cycles = cycles + 1;
      #1;
    end

    if (~halt) begin
      $display("FALLITO  nessun halt entro %0d cicli", cycles);
      $finish;
    end
    if (emitted != 7) begin
      $display("FALLITO  %0d uscite invece di 7", emitted);
      $finish;
    end

    $display("OK  halt al ciclo %0d, pc=%0d, %0d uscite corrette",
             cycles, pc, emitted);
    $display("    a 10 Hz (block time Robinhood Chain) sono %0d ms di esecuzione",
             cycles * 100);
    $finish;
  end

endmodule

`default_nettype wire
