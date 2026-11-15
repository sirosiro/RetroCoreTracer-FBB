; ============================================================================
; Z80 Simple Run-Length Encoding (RLE) Encode / Decode & Self-Check
;
; Overview:
;   1. Encodes SRC_DATA into RLE pairs [Count, Value] at CMP_BUF (0x00 = EOF).
;   2. Decodes CMP_BUF back into raw bytes at DST_BUF.
;   3. Verifies DST_BUF matches SRC_DATA byte-for-byte.
;
; Result at HALT:
;   A  = 0x00 (Success) / 0xFF (Failure)
;   BC = Compressed byte size (including 0x00 terminator)
; ============================================================================

        ORG     0x0000

STACK_TOP:  EQU 0x8000      ; Stack pointer initial address
SRC_LEN:    EQU 16          ; Source data length in bytes
STATUS_OK:  EQU 0x00
STATUS_ERR: EQU 0xFF

START:
        LD      SP, STACK_TOP

        ; --------------------------------------------------------------------
        ; Step 1: RLE Encode (SRC_DATA -> CMP_BUF)
        ; --------------------------------------------------------------------
        LD      HL, SRC_DATA    ; HL = source pointer
        LD      DE, CMP_BUF     ; DE = compressed output pointer
        LD      B, SRC_LEN      ; B  = remaining input bytes

        CALL    RLE_ENCODE

        ; Calculate compressed size: BC = DE - CMP_BUF
        EX      DE, HL          ; HL = current output end pointer
        LD      DE, CMP_BUF
        OR      A               ; Clear Carry flag before SBC
        SBC     HL, DE          ; HL = compressed size
        PUSH    HL              ; Save compressed size on stack

        ; --------------------------------------------------------------------
        ; Step 2: RLE Decode (CMP_BUF -> DST_BUF)
        ; --------------------------------------------------------------------
        LD      HL, CMP_BUF     ; HL = compressed input pointer
        LD      DE, DST_BUF     ; DE = decoded output pointer

        CALL    RLE_DECODE

        ; --------------------------------------------------------------------
        ; Step 3: Self-Check (Compare SRC_DATA and DST_BUF)
        ; --------------------------------------------------------------------
        LD      HL, SRC_DATA
        LD      DE, DST_BUF
        LD      B, SRC_LEN

        CALL    VERIFY_DATA

        POP     BC              ; Restore compressed size into BC
        HALT                    ; End of test (Check A == 0x00, BC == 13)

; ============================================================================
; Subroutine: RLE_ENCODE
; Input : HL = Source address, DE = Destination address, B = Source length
; Output: DE = Next free byte in destination buffer
; ============================================================================
RLE_ENCODE:
        LD      A, B
        OR      A
        JR      Z, .ENC_EOF     ; If length == 0, write terminator only

.ENC_NEXT_RUN:
        LD      A, (HL)         ; Read current byte value
        INC     HL
        DEC     B
        LD      C, 1            ; C = run count (starts at 1)

.ENC_COUNT_LOOP:
        LD      A, B
        OR      A               ; Check if end of source reached
        JR      Z, .ENC_WRITE_PAIR

        LD      A, (HL)         ; Peek next byte
        DEC     HL
        CP      (HL)            ; Compare next byte with current run byte
        INC     HL
        JR      NZ, .ENC_WRITE_PAIR ; Different byte -> flush current run

        ; Same byte continues
        INC     C               ; Increment run count
        INC     HL              ; Advance source pointer
        DEC     B               ; Decrement remaining source bytes
        JR      .ENC_COUNT_LOOP

.ENC_WRITE_PAIR:
        ; Retrieve the byte value just counted (at HL - 1)
        DEC     HL
        LD      A, (HL)
        INC     HL

        ; Write [Count, Value] to (DE)
        PUSH    AF              ; Save byte value
        LD      A, C            ; A = Count
        LD      (DE), A
        INC     DE
        POP     AF              ; A = Value
        LD      (DE), A
        INC     DE

        LD      A, B
        OR      A
        JR      NZ, .ENC_NEXT_RUN

.ENC_EOF:
        XOR     A               ; A = 0x00 (End-of-Stream marker)
        LD      (DE), A
        INC     DE
        RET

; ============================================================================
; Subroutine: RLE_DECODE
; Input : HL = Compressed buffer, DE = Destination buffer
; ============================================================================
RLE_DECODE:
.DEC_LOOP:
        LD      A, (HL)         ; Read run count
        INC     HL
        OR      A               ; Count == 0x00 means end of compressed stream
        RET     Z

        LD      B, A            ; B = repeat count
        LD      A, (HL)         ; A = byte value to repeat
        INC     HL

.DEC_FILL:
        LD      (DE), A
        INC     DE
        DJNZ    .DEC_FILL

        JR      .DEC_LOOP

; ============================================================================
; Subroutine: VERIFY_DATA
; Input : HL = Buffer 1, DE = Buffer 2, B = Length
; Output: A = STATUS_OK (0x00) if identical, STATUS_ERR (0xFF) if mismatch
; ============================================================================
VERIFY_DATA:
.VER_LOOP:
        LD      A, (DE)
        CP      (HL)
        JR      NZ, .VER_FAIL
        INC     HL
        INC     DE
        DJNZ    .VER_LOOP

        LD      A, STATUS_OK
        RET

.VER_FAIL:
        LD      A, STATUS_ERR
        RET

; ============================================================================
; Data & Work Buffers
; ============================================================================
        ORG     0x0200

SRC_DATA:
        ; 16 bytes -> compresses into 6 pairs (12 bytes) + 1 EOF byte = 13 bytes
        DB      0xAA, 0xAA, 0xAA, 0xAA  ; Run of 4 x 0xAA
        DB      0x55                    ; Run of 1 x 0x55
        DB      0xFF, 0xFF, 0xFF        ; Run of 3 x 0xFF
        DB      0x12, 0x34              ; Two singletons (1 x 0x12, 1 x 0x34)
        DB      0x7E, 0x7E, 0x7E, 0x7E, 0x7E, 0x7E ; Run of 6 x 0x7E

        ORG     0x0300
CMP_BUF:
        DS      32              ; Reserved space for compressed output

        ORG     0x0400
DST_BUF:
        DS      32              ; Reserved space for decompressed output