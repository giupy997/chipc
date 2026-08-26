; echo8.asm — il programma di mainnet. Il chip che ascolta.
;
; Non contiene HLT e non puo' contenerlo. Ogni giro legge il byte che lo
; sponsor ha passato a tick(), lo rimanda in eco, lo somma a un accumulatore
; che vive in RAM, e mostra la somma. Due uscite per giro: quello che hai
; detto tu, e tutto quello che il chip ha sentito finora.
;
;   r0  il byte in ingresso
;   r1  indirizzo dell'accumulatore
;   r2  l'accumulatore

start:  in   r0
        out  r0             ; eco
        ldi  r1, #0x10
        ld   r2, [r1]
        nop                 ; la load si chiude qui
        add  r2, r0
        st   [r1], r2
        out  r2             ; la somma di tutto
        jmp  start
