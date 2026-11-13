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

if __name__ == "__main__":
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "examples"
    os.makedirs(out_dir, exist_ok=True)
    p2_file = os.path.join(out_dir, "z80_test_02_alu_flags_daa.hex")
    generate_phase2_hex(p2_file)

