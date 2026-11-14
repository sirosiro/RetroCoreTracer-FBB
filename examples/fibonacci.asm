; ========================================================
;  RetroCoreTracer Z80 Demo: Fibonacci Calculation
;  Author: sirosiro (FPGA-BoardlessBench Project)
;
;  [Design Intent]
;  Computes Fibonacci numbers iteratively in Register A.
;  Register B stores the current sum, Register C stores previous.
;  Observability: Watch registers A, B, and C update in RCT.
; ========================================================

    ORG 0000h

START:
    NOP             ; Reset/Entry NOP
    LD A, 01h       ; Initial Fibonacci A = 1
    LD B, 01h       ; Initial Fibonacci B = 1
    LD C, 00h       ; Clear C = 0

LOOP:
    ; --- Core Computation: A = A + B ---
    ADD A, B        ; Compute next Fibonacci number
    LD C, B         ; Save previous B to C
    LD B, A         ; Update B to new sum
    JR LOOP         ; Repeat loop indefinitely
    HALT            ; Unreachable safety HALT

