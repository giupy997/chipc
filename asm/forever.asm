; forever.asm — il programma che il processore esegue in mainnet.
;
; Non contiene HLT. Non puo' contenerlo: se la RH-4 si ferma, si ferma per
; sempre, perche' solo l'operatore puo' resettarla. Questo programma e'
; scritto per non arrivare mai in fondo.
;
; Tre movimenti in loop, ognuno guardabile sulle 4 uscite:
;
;   1. SCANNER   un bit rimbalza avanti e indietro    1 2 4 8 8 4 2 1
;   2. CONTATORE conta da 0 a 15 e ricomincia         0 1 2 ... 14 15
;   3. RUMORE    LFSR a 4 bit, periodo 15             1 2 4 9 3 6 13 ...
;
; Registri:
;   r0  contatore di passaggi (condiviso fra i movimenti)
;   r1  scanner
;   r2  contatore
;   r3  stato dell'LFSR
;   r4  temporaneo — bit 3 dell'LFSR
;   r5  temporaneo — bit di retroazione
;   r6  costante 1, serve a mascherare (non c'e' una AND nella ISA)
;   r7  secondo contatore di passaggi

; ---------------------------------------------------------------- movimento 1
; Un bit sale fino a 8, rimbalza, torna giu' fino a 1, rimbalza. Sedici
; rimbalzi completi e si passa al movimento successivo.

start:  ldi  r0, #0
        ldi  r1, #1

left:   out  r1
        add  r1, r1         ; scorri a sinistra; il carry dice che 8 e' uscito
        jc   turnr
        jmp  left

turnr:  ldi  r1, #8

right:  out  r1
        shr  r1             ; scorri a destra; il carry dice che 1 e' uscito
        jc   turnl
        jmp  right

turnl:  ldi  r1, #1
        inc  r0             ; un rimbalzo in piu'
        jz   count          ; r0 e' tornato a zero: sedici rimbalzi fatti
        jmp  left

; ---------------------------------------------------------------- movimento 2
; Sedici passaggi da sedici valori: 256 uscite in salita.

count:  ldi  r2, #0

cloop:  out  r2
        inc  r2
        jnz  cloop          ; finche' r2 non torna a zero
        inc  r0
        jnz  cloop          ; sedici passaggi
        jmp  noise

; ---------------------------------------------------------------- movimento 3
; LFSR a 4 bit con prese sui bit 3 e 2 (x^4 + x^3 + 1): periodo 15, passa per
; tutti i valori tranne lo zero. Lo zero e' l'unico stato assorbente e non
; viene mai raggiunto, quindi il rumore non si spegne.

noise:  ldi  r6, #1
        ldi  r3, #1         ; seme, qualunque valore diverso da zero

nloop:  out  r3

        mov  r4, r3
        shr  r4
        shr  r4
        shr  r4             ; r4 = bit 3

        mov  r5, r3
        shr  r5
        shr  r5             ; r5 = bit 3 e bit 2
        xor  r5, r4         ; il bit 0 di r5 ora e' bit3 xor bit2

        nand r5, r6         ; niente AND nella ISA: due NAND in fila
        nand r5, r5         ; isolano il bit 0

        add  r3, r3         ; scorri a sinistra
        add  r3, r5         ; e infila il bit di retroazione

        inc  r0
        jnz  nloop
        inc  r7
        jnz  nloop          ; 256 uscite di rumore
        jmp  start
