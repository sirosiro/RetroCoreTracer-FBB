; ============================================================================
; Z80 Mini Bytecode VM & Parser Edge-Case Stress Test (Self-Checking)
;
; Tests:
;   1. Forward-referenced jump table via DW (OP_TABLE)
;   2. String literals (DB "...") and location counter expressions ($ - LABEL)
;   3. Indexed addressing with EQU offsets (IX+OFF_...) and negative (IY-1)
;   4. DD CB prefix bit operations: BIT/SET/RES n, (IX+d)
;   5. Shadow registers: EX AF, AF' and EXX (quote lexer test!)
;   6. 16-bit ADC HL, BC and BCD DAA adjustment
;
; Result at HALT:
;   A  = 0x00 (Success) / 0xFF (Failure)
;   HL = Final 16-bit Accumulator (Expected: 0x1234)
;   B  = BCD Checksum (Expected: 0x42)
; ============================================================================

        ORG     0x0000

STACK_TOP   EQU 0x8000
STATUS_OK   EQU 0x00
STATUS_ERR  EQU 0xFF

; VM Context Structure Offsets (accessed via IX)
OFF_PC_L    EQU 0
OFF_PC_H    EQU 1
OFF_ACC_L   EQU 2
OFF_ACC_H   EQU 3
OFF_FLAGS   EQU 4
OFF_BCD     EQU 5

; Flag bits inside (IX + OFF_FLAGS)
FLAG_ZERO   EQU 0
FLAG_CARRY  EQU 1
FLAG_HALT   EQU 7

START:
        LD      SP, STACK_TOP

        ; Initialize IX to VM Context structure
        LD      IX, VM_CTX

        ; Set initial VM PC = BYTECODE_PROG
        LD      HL, BYTECODE_PROG
        LD      (IX + OFF_PC_L), L
        LD      (IX + OFF_PC_H), H

        ; Clear VM Accumulator, Flags, and BCD register
        XOR     A
        LD      (IX + OFF_ACC_L), A
        LD      (IX + OFF_ACC_H), A
        LD      (IX + OFF_FLAGS), A
        LD      (IX + OFF_BCD), A

        ; Initialize Shadow Registers to verify EXX / EX AF, AF' preservation
        LD      A, 0x5A
        EX      AF, AF'             ; Save 0x5A into A'
        EXX
        LD      BC, 0xCAFE
        LD      DE, 0xBABE
        LD      HL, 0xDEAD
        EXX

; ----------------------------------------------------------------------------
; Main VM Fetch-Decode-Execute Loop
; ----------------------------------------------------------------------------
VM_LOOP:
        ; Check if FLAG_HALT (bit 7) is set in (IX + OFF_FLAGS)
        BIT     FLAG_HALT, (IX + OFF_FLAGS)
        JR      NZ, VM_VERIFY

        ; Fetch next opcode via VM PC
        CALL    VM_FETCH_BYTE       ; Returns opcode in A

        ; Bounds check against OP_COUNT (computed via $ expression)
        CP      OP_COUNT
        JP      NC, VM_FAIL

        ; Dispatch via Jump Table: HL = OP_TABLE + (A * 2)
        ADD     A, A                ; A = opcode * 2
        LD      E, A
        LD      D, 0
        LD      HL, OP_TABLE
        ADD     HL, DE

        ; Load handler address from DW table (Little-Endian)
        LD      E, (HL)
        INC     HL
        LD      D, (HL)
        EX      DE, HL

        ; Call handler using JP (HL) trampoline
        CALL    CALL_HL
        JR      VM_LOOP

CALL_HL:
        JP      (HL)

; ----------------------------------------------------------------------------
; Helper: Fetch 1 byte from VM PC and increment VM PC
; ----------------------------------------------------------------------------
VM_FETCH_BYTE:
        LD      L, (IX + OFF_PC_L)
        LD      H, (IX + OFF_PC_H)
        LD      A, (HL)
        INC     HL
        LD      (IX + OFF_PC_L), L
        LD      (IX + OFF_PC_H), H
        RET

; ----------------------------------------------------------------------------
; VM Opcode Handlers (Forward-referenced by OP_TABLE)
; ----------------------------------------------------------------------------

; 0x00: NOP
OP_NOP:
        RET

; 0x01: LOAD16 imm16 -> ACC
OP_LOAD16:
        CALL    VM_FETCH_BYTE
        LD      (IX + OFF_ACC_L), A
        CALL    VM_FETCH_BYTE
        LD      (IX + OFF_ACC_H), A
        RET

; 0x02: ADD16 imm16 -> ACC = ACC + imm16 (sets FLAG_CARRY on overflow)
OP_ADD16:
        CALL    VM_FETCH_BYTE
        LD      C, A
        CALL    VM_FETCH_BYTE
        LD      B, A                ; BC = imm16

        LD      L, (IX + OFF_ACC_L)
        LD      H, (IX + OFF_ACC_H) ; HL = ACC

        OR      A                   ; Clear Carry
        ADC     HL, BC              ; 16-bit ADC test

        JR      C, .SET_C
        RES     FLAG_CARRY, (IX + OFF_FLAGS)
        JR      .SAVE_ACC
.SET_C:
        SET     FLAG_CARRY, (IX + OFF_FLAGS)
.SAVE_ACC:
        LD      (IX + OFF_ACC_L), L
        LD      (IX + OFF_ACC_H), H
        RET

; 0x03: BCD_ADD imm8 -> (IX+OFF_BCD) = BCD((IX+OFF_BCD) + imm8)
OP_BCD_ADD:
        CALL    VM_FETCH_BYTE       ; imm8 (BCD)
        ADD     A, (IX + OFF_BCD)
        DAA                         ; Decimal Adjust Accumulator test
        LD      (IX + OFF_BCD), A
        RET

; 0x04: STR_LEN_ADD -> Adds length of embedded ASCII string to ACC
OP_STR_LEN:
        LD      A, MSG_LEN          ; Computed by EQU ($ - MSG_STR)
        LD      C, A
        LD      B, 0
        LD      L, (IX + OFF_ACC_L)
        LD      H, (IX + OFF_ACC_H)
        ADD     HL, BC
        LD      (IX + OFF_ACC_L), L
        LD      (IX + OFF_ACC_H), H
        RET

; 0x05: HALT_VM -> Sets bit 7 of (IX + OFF_FLAGS)
OP_HALT:
        SET     FLAG_HALT, (IX + OFF_FLAGS)
        RET

; ----------------------------------------------------------------------------
; Verification Phase (Self-Check)
; ----------------------------------------------------------------------------
VM_VERIFY:
        ; 1. Verify negative IY offset addressing: point IY past VM_CTX
        LD      IY, VM_CTX_END
        LD      A, (IY - 1)         ; Reads (IX + OFF_BCD)
        CP      0x42                ; Expected BCD: 0x15 + 0x27 = 0x42
        JR      NZ, VM_FAIL

        ; 2. Verify Shadow Registers were untouched during VM execution
        EX      AF, AF'
        CP      0x5A
        JR      NZ, VM_FAIL
        EX      AF, AF'

        EXX
        LD      A, B
        CP      0xCA
        JR      NZ, VM_FAIL_EXX
        LD      A, H
        CP      0xDE
        JR      NZ, VM_FAIL_EXX
        EXX

        ; 3. Verify Final 16-bit Accumulator == 0x1234
        ;    Calculation: 0x1000 + 0x0228 + MSG_LEN(12 = 0x0C) = 0x1234
        LD      L, (IX + OFF_ACC_L)
        LD      H, (IX + OFF_ACC_H)
        LD      DE, 0x1234
        OR      A
        SBC     HL, DE
        JR      NZ, VM_FAIL

        ; Restore expected output values for inspection
        LD      L, (IX + OFF_ACC_L)
        LD      H, (IX + OFF_ACC_H) ; HL = 0x1234
        LD      B, (IX + OFF_BCD)   ; B  = 0x42
        LD      A, STATUS_OK        ; A  = 0x00
        HALT

VM_FAIL_EXX:
        EXX
VM_FAIL:
        LD      A, STATUS_ERR       ; A  = 0xFF
        HALT

; ============================================================================
; Data Tables, Strings & Bytecode Program
; ============================================================================
        ORG     0x0200

; Forward-referenced Jump Table
OP_TABLE:
        DW      OP_NOP              ; 0x00
        DW      OP_LOAD16           ; 0x01
        DW      OP_ADD16            ; 0x02
        DW      OP_BCD_ADD          ; 0x03
        DW      OP_STR_LEN          ; 0x04
        DW      OP_HALT             ; 0x05
OP_COUNT    EQU ($ - OP_TABLE) / 2

; String Literal & Location Counter Length Expression
MSG_STR:
        DB      "Z80-ASM-TEST"      ; 12 bytes (0x0C)
MSG_LEN     EQU $ - MSG_STR
        DB      0x00                ; Null terminator

; VM Bytecode Stream
BYTECODE_PROG:
        DB      0x00                ; NOP
        DB      0x01, 0x00, 0x10    ; LOAD16 0x1000
        DB      0x02, 0x28, 0x02    ; ADD16  0x0228  -> ACC = 0x1228
        DB      0x03, 0x15          ; BCD_ADD 0x15   -> BCD = 0x15
        DB      0x03, 0x27          ; BCD_ADD 0x27   -> BCD = 0x42 (15+27=42!)
        DB      0x04                ; STR_LEN_ADD    -> ACC = 0x1228 + 12 = 0x1234
        DB      0x05                ; HALT_VM

; ============================================================================
; VM Context Work Area
; ============================================================================
        ORG     0x0300

VM_CTX:
        DS      6                   ; [PC_L, PC_H, ACC_L, ACC_H, FLAGS, BCD]
VM_CTX_END: