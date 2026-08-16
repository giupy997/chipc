; fib.asm — Fibonacci a 4 bit sulla RH-4.
;
; Stesso programma dimostrativo del processore su BNB: 1 1 2 3 5 8 13.
; Al passo dopo il 13 la somma sfora i 4 bit, il carry va a 1 e si ferma.
;
;   r0 = fib(n-1)
;   r1 = fib(n)
;   r2 = scratch

        ldi  r0, #0
        ldi  r1, #1

loop:   out  r1             ; sputa il termine corrente sulla porta di uscita
        mov  r2, r0
        add  r2, r1         ; r2 = r0 + r1, aggiorna il carry
        jc   done           ; sforato i 4 bit: fine corsa
        mov  r0, r1
        mov  r1, r2
        jmp  loop

done:   hlt
