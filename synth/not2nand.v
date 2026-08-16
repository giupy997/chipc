// not2nand.v — un NOT e' un NAND con gli ingressi in corto.
// Serve per chiudere la netlist su un'unica primitiva: solo $_NAND_.
(* techmap_celltype = "$_NOT_" *)
module _not_to_nand_ (input A, output Y);
  $_NAND_ _TECHMAP_REPLACE_ (.A(A), .B(A), .Y(Y));
endmodule
