; ============================================================================
; Z80 Bus Protection & Memory Violation Test (Self-Checking)
;
; Purpose:
;   Deliberately exercises legal and illegal memory operations defined in DTS:
;     - ROM0 : 0x0000 - 0x3FFF (Read-Only)
;     - UNMAP: 0x4000 - 0x7FFF (Unmapped Hole)
;     - RAM0 : 0x8000 - 0xFFFF (Read/Write)
;
; Test Sequence:
;   1. Legal ROM Read        : Read byte from ROM (0x0200) -> /CS_ROM active, RD active
;   2. Legal RAM Write & Read: Write 0x5A to RAM (0x8000), read back -> /CS_RAM active
;   3. Illegal ROM Write     : Attempt write to 0x0200 -> Blocked by write-protect,
;                              state.busViolation = 'ROM_WRITE'
;   4. Illegal Unmapped Write: Attempt write to 0x5000 -> Blocked,
;                              state.busViolation = 'UNMAPPED_WRITE'
;   5. Illegal Unmapped Read : Attempt read from 0x5000 -> Float bus returns 0xFF,
;                              state.busViolation = 'UNMAPPED_READ'
;   6. Clean Halt            : A = 0x00 (Success), B = 0x5A (RAM verify), C = 0xFF (Unmapped verify)
;
; Result at HALT:
;   A = 0x00 (Success) / 0xFF (Failure)
;   B = 0x5A
;   C = 0xFF
; ============================================================================

        ORG     0x0000

STACK_TOP       EQU 0x0000      ; Top of RAM (0x8000-0xFFFF, SP wraps to 0xFFFF on push)
ROM_TEST_ADDR   EQU 0x0200      ; Within ROM0 (0x0000-0x3FFF, Read-Only)
RAM_TEST_ADDR   EQU 0x8000      ; Within RAM0 (0x8000-0xFFFF, Read/Write)
UNMAPPED_ADDR   EQU 0x5000      ; Within Unmapped Hole (0x4000-0x7FFF)

STATUS_OK       EQU 0x00
STATUS_ERR      EQU 0xFF

START:
        LD      SP, STACK_TOP

        ; --------------------------------------------------------------------
        ; Stage 1: Legal ROM Read
        ; --------------------------------------------------------------------
        LD      HL, ROM_TEST_ADDR
        LD      A, (HL)         ; Read initial test constant from ROM
        CP      0x3C            ; Expected byte: 0x3C
        JP      NZ, FAIL

        ; --------------------------------------------------------------------
        ; Stage 2: Legal RAM Write and Readback
        ; --------------------------------------------------------------------
        LD      HL, RAM_TEST_ADDR
        LD      (HL), 0x5A      ; Legal write to RAM0
        LD      A, (HL)         ; Readback
        CP      0x5A            ; Verify write succeeded
        JP      NZ, FAIL
        LD      B, A            ; Save 0x5A to B for inspection

        ; --------------------------------------------------------------------
        ; Stage 3: Intentional Violation #1 - Illegal ROM Write
        ; Hardware protection blocks the write; ROM data remains intact.
        ; RCT UI raises alert banner: [BUS VIOLATION: ROM_WRITE]
        ; --------------------------------------------------------------------
        LD      HL, ROM_TEST_ADDR
        LD      (HL), 0x99      ; ATTEMPT WRITE TO ROM (Violation: ROM_WRITE!)
        LD      A, (HL)         ; Readback ROM
        CP      0x3C            ; Verify ROM was NOT modified (remains 0x3C)
        JP      NZ, FAIL

        ; --------------------------------------------------------------------
        ; Stage 4: Intentional Violation #2 - Illegal Unmapped Write
        ; Dropped by bus controller; neither /CS_ROM nor /CS_RAM asserted.
        ; RCT UI raises alert banner: [BUS VIOLATION: UNMAPPED_WRITE]
        ; --------------------------------------------------------------------
        LD      HL, UNMAPPED_ADDR
        LD      (HL), 0xAA      ; ATTEMPT WRITE TO UNMAPPED (Violation: UNMAPPED_WRITE!)

        ; --------------------------------------------------------------------
        ; Stage 5: Intentional Violation #3 - Illegal Unmapped Read
        ; Bus pull-up / float returns 0xFF.
        ; RCT UI raises alert banner: [BUS VIOLATION: UNMAPPED_READ]
        ; --------------------------------------------------------------------
        LD      HL, UNMAPPED_ADDR
        LD      A, (HL)         ; ATTEMPT READ FROM UNMAPPED (Violation: UNMAPPED_READ!)
        CP      0xFF            ; Float bus returns 0xFF
        JP      NZ, FAIL
        LD      C, A            ; Save 0xFF to C for inspection

        ; --------------------------------------------------------------------
        ; Stage 6: Success Completion
        ; --------------------------------------------------------------------
        LD      A, STATUS_OK    ; A = 0x00
        HALT

FAIL:
        LD      A, STATUS_ERR   ; A = 0xFF
        HALT

; ============================================================================
; ROM Constant Data (0x0200)
; ============================================================================
        ORG     0x0200
ROM_SAMPLE_DATA:
        DB      0x3C, 0x42, 0xAA, 0x55

