#!/usr/bin/env python3
"""
@intent:responsibility Z80 テスト用 Intel HEX ファイル生成スクリプト
レコードフォーマット: :llaaaatt[dd...]cc
"""
import sys
import os

def make_hex_record(addr: int, data: bytes, rectype: int = 0) -> str:
    length = len(data)
    record = bytearray([length, (addr >> 8) & 0xFF, addr & 0xFF, rectype]) + data
    checksum = ((~sum(record) + 1) & 0xFF)
    hex_str = ":" + record.hex().upper() + f"{checksum:02X}"
    return hex_str

def write_intel_hex(filepath: str, addr_bytes_map: dict):
    lines = []
    # Sort addresses
    sorted_addrs = sorted(addr_bytes_map.keys())
    for addr in sorted_addrs:
        data = addr_bytes_map[addr]
        # Chunk into 16-byte max records
        for i in range(0, len(data), 16):
            chunk = data[i:i+16]
            lines.append(make_hex_record(addr + i, chunk, 0))
    lines.append(":00000001FF\n") # EOF record
    with open(filepath, "w") as f:
        f.write("\n".join(lines))
    print(f"[+] Wrote Intel HEX: {filepath}")

def generate_phase2_hex(output_path: str):
    # Phase 2: 8-bit ALU, DAA, CPL, SCF, CCF, Rotates, (HL) and (nn) memory access
    prog = bytearray([
        # 0x0000:
        0x3E, 0x12,       # LD A, $12
        0x06, 0x34,       # LD B, $34
        0x80,             # ADD A, B       (A = 0x46)
        0x27,             # DAA            (A = 0x46)
        0x0E, 0x29,       # LD C, $29
        0x81,             # ADD A, C       (0x46 + 0x29 = 0x6F)
        0x27,             # DAA            (0x6F -> 0x75 BCD)
        0x2F,             # CPL            (A = ~0x75 = 0x8A)
        0x37,             # SCF            (C = 1)
        0x3F,             # CCF            (C = 0)
        0x07,             # RLCA           (0x8A -> 0x15, C=1)
        0x0F,             # RRCA           (0x15 -> 0x8A, C=1)
        0x32, 0x00, 0x01, # LD ($0100), A  (mem[0x0100] = 0x8A)
        0x3E, 0x00,       # LD A, $00      (clear A)
        0x3A, 0x00, 0x01, # LD A, ($0100)  (A = 0x8A)
        0x26, 0x02,       # LD H, $02
        0x2E, 0x00,       # LD L, $00      (HL = 0x0200)
        0x36, 0x55,       # LD (HL), $55   (mem[0x0200] = 0x55)
        0x34,             # INC (HL)       (mem[0x0200] = 0x56)
        0x7E,             # LD A, (HL)     (A = 0x56)
        0x76              # HALT
    ])
    write_intel_hex(output_path, {0x0000: prog})

def generate_phase3_hex(output_path: str):
    # Phase 3: 16-bit LD, ADD HL, INC/DEC ss, PUSH/POP, CALL/RET, JR cc, RST, EX (SP), HL
    addr_map = {
        0x0000: bytearray([
            0xC3, 0x40, 0x00  # 0000: JP $0040
        ]),
        0x0010: bytearray([
            0xC9              # 0010: RET
        ]),
        0x0030: bytearray([
            0xE3,             # 0030: EX (SP), HL
            0xE3,             # 0031: EX (SP), HL
            0xC9              # 0032: RET
        ]),
        0x0040: bytearray([
            0x31, 0x00, 0x10, # 0040: LD SP, $1000
            0x21, 0x34, 0x12, # 0043: LD HL, $1234
            0x22, 0x80, 0x00, # 0046: LD ($0080), HL
            0x21, 0x00, 0x00, # 0049: LD HL, $0000
            0x2A, 0x80, 0x00, # 004C: LD HL, ($0080)
            0x01, 0x11, 0x01, # 004F: LD BC, $0111
            0x09,             # 0052: ADD HL, BC
            0x03,             # 0053: INC BC
            0x0B,             # 0054: DEC BC
            0xE5,             # 0055: PUSH HL
            0xD1,             # 0056: POP DE
            0xCD, 0x30, 0x00, # 0057: CALL $0030
            0x97,             # 005A: SUB A
            0x28, 0x03,       # 005B: JR Z, +3 -> $0060
            0x76, 0x76, 0x76, # 005D..005F: trap HALTs
            0xD7,             # 0060: RST $10
            0x76              # 0061: HALT
        ])
    }
    write_intel_hex(output_path, addr_map)

def generate_phase4_hex(output_path):
    """
    Phase 4: CB プレフィックス全 256 命令 (シフト/ローテート/ビット操作/レジスタ & (HL))
    """
    code = bytes([
        0x3E, 0x85,       # 0000: LD A, $85 (10000101)
        0xCB, 0x07,       # 0002: RLC A -> $0B (00001011), C=1
        0xCB, 0x0F,       # 0004: RRC A -> $85 (10000101), C=1
        0x37,             # 0006: SCF (C=1)
        0xCB, 0x17,       # 0007: RL A  -> $0B (bit0=old C=1), C=1
        0xAF,             # 0009: XOR A (A=0, C=0)
        0x06, 0x55,       # 000A: LD B, $55 (01010101)
        0xCB, 0x20,       # 000C: SLA B -> $AA (10101010), C=0
        0xCB, 0x28,       # 000E: SRA B -> $D5 (11010101: 符号維持), C=0
        0xCB, 0x38,       # 0010: SRL B -> $6A (01101010: 0挿入), C=1
        0xCB, 0x40,       # 0012: BIT 0, B (bit0 of $6A is 0 -> Z=1, H=1)
        0xCB, 0x48,       # 0014: BIT 1, B (bit1 of $6A is 1 -> Z=0, H=1)
        0xCB, 0xC0,       # 0016: SET 0, B -> $6B
        0xCB, 0x88,       # 0018: RES 1, B -> $69
        # (HL) メモリアクセス検証
        0x21, 0x00, 0x01, # 001A: LD HL, $0100
        0x36, 0x81,       # 001D: LD (HL), $81
        0xCB, 0x06,       # 001F: RLC (HL) -> (HL)=$03, C=1
        0xCB, 0x4E,       # 0021: BIT 1, (HL) -> Z=0, H=1
        0xCB, 0x86,       # 0023: RES 0, (HL) -> (HL)=$02
        0xCB, 0xFE,       # 0025: SET 7, (HL) -> (HL)=$82
        0x7E,             # 0027: LD A, (HL) -> A=$82
        0x76              # 0028: HALT
    ])
    write_intel_hex(output_path, {0x0000: code})

def generate_phase5_hex(output_path):
    """
    Phase 5: ED プレフィックス全命令 (16bit LD, 16bit ADC/SBC, NEG, I/R/IM, RRD/RLD, I/O, LDIR, CPIR)
    """
    code = bytes([
        # 1. 16-bit LD dd, (nn) / LD (nn), dd
        0x01, 0x34, 0x12,       # 0000: LD BC, $1234
        0xED, 0x43, 0x80, 0x01, # 0003: LD ($0180), BC
        0xED, 0x5B, 0x80, 0x01, # 0007: LD DE, ($0180) -> DE = $1234
        # 2. 16-bit ADC/SBC HL, ss
        0x21, 0x00, 0x10,       # 000B: LD HL, $1000
        0xAF,                   # 000E: XOR A (C=0)
        0xED, 0x4A,             # 000F: ADC HL, BC -> HL = $2234
        0xED, 0x52,             # 0011: SBC HL, DE -> HL = $1000
        # 3. NEG & Special Regs
        0x3E, 0x05,             # 0013: LD A, $05
        0xED, 0x44,             # 0015: NEG -> A = $FB (-5)
        0x3E, 0x42,             # 0017: LD A, $42
        0xED, 0x47,             # 0019: LD I, A -> I = $42
        0x3E, 0x00,             # 001B: LD A, $00
        0xED, 0x57,             # 001D: LD A, I -> A = $42
        0xED, 0x56,             # 001F: IM 1
        # 4. RRD / RLD
        0x21, 0x00, 0x02,       # 0021: LD HL, $0200
        0x36, 0x34,             # 0024: LD (HL), $34
        0x3E, 0x12,             # 0026: LD A, $12
        0xED, 0x67,             # 0028: RRD -> A = $14, (HL) = $23
        # 5. I/O Instructions
        0x3E, 0x77,             # 002A: LD A, $77
        0xD3, 0x10,             # 002C: OUT ($10), A
        0x3E, 0x00,             # 002E: LD A, $00
        0xDB, 0x10,             # 0030: IN A, ($10) -> A = $77
        0x06, 0x88,             # 0032: LD B, $88
        0x0E, 0x20,             # 0034: LD C, $20
        0xED, 0x41,             # 0036: OUT (C), B
        0x06, 0x00,             # 0038: LD B, $00
        0xED, 0x40,             # 003A: IN B, (C) -> B = $88
        # 6. Block Copy LDIR
        0x21, 0x00, 0x03,       # 003C: LD HL, $0300
        0x36, 0xAA,             # 003F: LD (HL), $AA
        0x23,                   # 0041: INC HL
        0x36, 0xBB,             # 0042: LD (HL), $BB
        0x21, 0x00, 0x03,       # 0044: LD HL, $0300
        0x11, 0x10, 0x03,       # 0047: LD DE, $0310
        0x01, 0x02, 0x00,       # 004A: LD BC, $0002
        0xED, 0xB0,             # 004D: LDIR -> copies $AA, $BB to $0310
        # 7. Block Search CPIR
        0x21, 0x10, 0x03,       # 004F: LD HL, $0310
        0x01, 0x02, 0x00,       # 0052: LD BC, $0002
        0x3E, 0xBB,             # 0055: LD A, $BB
        0xED, 0xB1,             # 0057: CPIR -> finds $BB, stops with Z=1
        0x76                    # 0059: HALT
    ])
    write_intel_hex(output_path, {0x0000: code})

def generate_phase6_hex(output_path):
    code = bytearray([
        # 1. 16-bit IX / IY operations
        0xDD, 0x21, 0x00, 0x20, # 0000: LD IX, $2000
        0x01, 0x50, 0x00,       # 0004: LD BC, $0050
        0xDD, 0x09,             # 0007: ADD IX, BC -> IX = $2050
        0xDD, 0x23,             # 0009: INC IX -> IX = $2051
        0xDD, 0x2B,             # 000B: DEC IX -> IX = $2050
        0xDD, 0x22, 0x80, 0x01, # 000D: LD ($0180), IX
        0xFD, 0x2A, 0x80, 0x01, # 0011: LD IY, ($0180) -> IY = $2050

        # 2. Indexed Memory Access (IX+d) & (IY+d)
        0xDD, 0x36, 0x04, 0xAA, # 0015: LD (IX+$04), $AA -> ($2054) = $AA
        0xDD, 0x7E, 0x04,       # 0019: LD A, (IX+$04) -> A = $AA
        0xDD, 0x34, 0x04,       # 001C: INC (IX+$04) -> ($2054) = $AB
        0xDD, 0x46, 0x04,       # 001F: LD B, (IX+$04) -> B = $AB
        0xDD, 0x86, 0x04,       # 0022: ADD A, (IX+$04) -> A = $AA + $AB = $55 (C=1)
        0xFD, 0x36, 0xFE, 0x33, # 0025: LD (IY-$02), $33 -> ($204E) = $33
        0xFD, 0x4E, 0xFE,       # 0029: LD C, (IY-$02) -> C = $33

        # 3. 8-bit IXH / IXL register access
        0xDD, 0x26, 0x5A,       # 002C: LD IXH, $5A -> IX = $5A50
        0xDD, 0x2E, 0xC3,       # 002F: LD IXL, $C3 -> IX = $5AC3
        0xDD, 0x7C,             # 0032: LD A, IXH -> A = $5A
        0xDD, 0x45,             # 0034: LD B, IXL -> B = $C3

        # 4. 4-byte DDCB operations on (IX+d)
        0xDD, 0xCB, 0x04, 0xFE, # 0036: SET 7, (IX+$04) -> ($2054) bit 7 = 1
        0xDD, 0xCB, 0x04, 0x7E, # 003A: BIT 7, (IX+$04) -> Z = 0
        0xDD, 0xCB, 0x04, 0xBE, # 003E: RES 7, (IX+$04) -> ($2054) bit 7 = 0
        0xDD, 0xCB, 0x04, 0x7E, # 0042: BIT 7, (IX+$04) -> Z = 1

        # 5. Stack PUSH / POP IX / IY
        0x31, 0x00, 0x10,       # 0046: LD SP, $1000
        0xDD, 0xE5,             # 0049: PUSH IX -> pushes $5AC3 to stack
        0xFD, 0xE1,             # 004B: POP IY -> IY = $5AC3
        0x76                    # 004D: HALT
    ])
    write_intel_hex(output_path, {0x0000: code})

if __name__ == "__main__":
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "examples"
    os.makedirs(out_dir, exist_ok=True)
    p2_file = os.path.join(out_dir, "z80_test_02_alu_flags_daa.hex")
    generate_phase2_hex(p2_file)
    p3_file = os.path.join(out_dir, "z80_test_03_branch_call_rst.hex")
    generate_phase3_hex(p3_file)
    p4_file = os.path.join(out_dir, "z80_test_04_cb_bit_shift.hex")
    generate_phase4_hex(p4_file)
    p5_file = os.path.join(out_dir, "z80_test_05_ed_block_io.hex")
    generate_phase5_hex(p5_file)
    p6_file = os.path.join(out_dir, "z80_test_06_ix_iy_indexed.hex")
    generate_phase6_hex(p6_file)

