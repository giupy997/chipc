; test8.asm — lo stesso programma del banco Verilog, riga per riga.
; Serve a una cosa sola: se l'assemblatore lo codifica identico alle parole
; scritte a mano nel testbench, l'assemblatore dice la verita'.
        in   r0
        ldi  r1, #0x20
        st   [r1], r0
        ldi  r0, #0
        ld   r2, [r1]
        nop                 ; la load si chiude qui
        out  r2
        ldi  r3, #200
        ldi  r4, #100
        add  r3, r4
        out  r3
        jc   13
        hlt
        ldi  r5, #255
        out  r5
        hlt
