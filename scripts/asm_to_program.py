#!/usr/bin/env python3
"""
asm_to_program.py - Assemble Z80 ASM files with rich listing & comments preservation
for RetroCoreTracer-FBB and FPGA-BoardlessBench.

Translates Z80 ASM into:
1. Intel HEX file (/tmp/rct_active.hex) for RTL Daemon simulation
2. Structured Program JSON (/tmp/rct_active_program.json) for DPPA Code View
   preserving original comments, block design notes, labels, and empty lines.
"""

import sys
import os
import re
import subprocess
import shutil

def write_intel_hex(file_path, mem_map):
    """Write memory dictionary {addr: [bytes]} to standard Intel HEX."""
    sorted_addrs = sorted(mem_map.keys())
    if not sorted_addrs:
        with open(file_path, "w") as f:
            f.write(":00000001FF\n")
        return

    with open(file_path, "w") as f:
        for start_addr in sorted_addrs:
            data = mem_map[start_addr]
            offset = 0
            while offset < len(data):
                chunk_len = min(16, len(data) - offset)
                chunk = data[offset : offset + chunk_len]
                addr = start_addr + offset
                record_type = 0x00
                checksum = chunk_len + (addr >> 8) + (addr & 0xFF) + record_type + sum(chunk)
                checksum = ((-checksum) & 0xFF)
                hex_data = "".join(f"{b:02X}" for b in chunk)
                f.write(f":{chunk_len:02X}{addr:04X}{record_type:02X}{hex_data}{checksum:02X}\n")
                offset += chunk_len
        f.write(":00000001FF\n")

def assemble_z80(asm_path, hex_path, json_path):
    # Check assembler availability: prefer z80asm, fallback to pasmo
    has_z80asm = shutil.which("z80asm") is not None
    has_pasmo = shutil.which("pasmo") is not None

    if not has_z80asm and not has_pasmo:
        # Attempt plugin-autonomous JIT installation of z80asm
        sys.stderr.write("[asm_to_program] Neither 'z80asm' nor 'pasmo' found. Attempting JIT installation of z80asm...\n")
        try:
            is_root = os.geteuid() == 0 if hasattr(os, "geteuid") else False
            has_apt = shutil.which("apt-get") is not None
            if has_apt:
                prefix = [] if is_root else ["sudo"]
                subprocess.run(prefix + ["apt-get", "update", "-qq"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                subprocess.run(prefix + ["apt-get", "install", "-y", "-qq", "z80asm"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                has_z80asm = shutil.which("z80asm") is not None
                if has_z80asm:
                    sys.stderr.write("[asm_to_program] ✨ JIT installation succeeded: z80asm is now available.\n")
        except Exception as e:
            sys.stderr.write(f"[asm_to_program] JIT installation encountered exception: {e}\n")

    if not has_z80asm and not has_pasmo:
        sys.stderr.write("[asm_to_program Error] Neither 'z80asm' nor 'pasmo' found in PATH.\n")
        sys.stderr.write("Please install via: apt-get install -y z80asm (or pasmo)\n")
        return False

    temp_bin = "/tmp/_rct_asm_out.bin"
    if os.path.exists(temp_bin):
        os.remove(temp_bin)

    listing_lines = []
    mem_map = {}
    first_pc = None

    if has_z80asm:
        # z80asm -l outputs listing to stderr and binary to temp_bin
        cmd = ["z80asm", "-l", "-o", temp_bin, asm_path]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            sys.stderr.write(f"[asm_to_program] z80asm failed:\n{res.stdout}\n{res.stderr}\n")
            return False
        # Listing output is captured in stderr
        listing_lines = (res.stderr or "").splitlines()
    else:
        # pasmo fallback
        cmd = ["pasmo", "--hex", asm_path, hex_path]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            sys.stderr.write(f"[asm_to_program] pasmo failed:\n{res.stdout}\n{res.stderr}\n")
            return False
        # When falling back to pasmo without listing, fallback to hex_to_program.py
        from hex_to_program import parse_intel_hex, disassemble_z80
        mem, min_a, max_a = parse_intel_hex(hex_path)
        prog = disassemble_z80(mem, min_a, max_a)
        import json
        with open(json_path, "w") as f:
            json.dump({
                "hexFile": os.path.basename(asm_path),
                "startPc": f"{min_a:04X}",
                "program": prog,
                "memory": [mem.get(i, 0) for i in range(min_a, min(min_a + 256, 65536))]
            }, f, indent=2)
        return True

    # Parse listing from z80asm
    program = []
    start_org = 0x0000
    pending_label = ""

    for raw_line in listing_lines:
        line = raw_line.rstrip()
        if not line:
            # Empty spacing line in source
            program.append({
                "addr": "", "bytes": "", "label": "", "mnem": "",
                "dest": "", "src": "", "comment": "", "isComment": True
            })
            continue

        # File section header / footer comments
        if line.startswith("# File "):
            fname = os.path.basename(line.replace("# File ", "").strip())
            program.append({
                "addr": "", "bytes": "", "label": "", "mnem": "",
                "dest": "", "src": "", "comment": f"; ===== [ File: {fname} ] =====", "isComment": True
            })
            continue
        if line.startswith("# End of file"):
            continue

        if len(line) < 4:
            continue

        addr_hex = line[:4].upper()
        addr_int = int(addr_hex, 16)
        rest = line[4:]

        # Check if line contains generated machine bytes
        # Format: '0000 3e 01\t\t...' vs '0000\t\t\t; ...'
        if rest.startswith(' ') and len(rest.strip()) > 0 and not rest.lstrip(' ').startswith('\t') and not rest.lstrip(' ').startswith(';'):
            parts = rest.split('\t')
            bytes_part = parts[0].strip().upper()
            src_part = '\t'.join(parts[1:]).strip()
        else:
            bytes_part = ""
            src_part = rest.strip()

        # Store generated machine bytes to memory map
        if bytes_part:
            if first_pc is None:
                first_pc = addr_hex
            b_list = [int(b, 16) for b in bytes_part.split()]
            if addr_int not in mem_map:
                mem_map[addr_int] = []
            mem_map[addr_int].extend(b_list)

        # Check if this line is comment-only or directive without code
        if not bytes_part:
            if not src_part:
                program.append({
                    "addr": "", "bytes": "", "label": "", "mnem": "",
                    "dest": "", "src": "", "comment": "", "isComment": True
                })
            elif src_part.startswith(';') or src_part.startswith('//'):
                program.append({
                    "addr": "", "bytes": "", "label": "", "mnem": "",
                    "dest": "", "src": "", "comment": src_part, "isComment": True
                })
            elif src_part.endswith(':'):
                pending_label = src_part
                program.append({
                    "addr": "", "bytes": "", "label": src_part, "mnem": "",
                    "dest": "", "src": "", "comment": "", "isLabel": True
                })
            else:
                # ORG, EQU, INCLUDE directive
                program.append({
                    "addr": "", "bytes": "", "label": "", "mnem": src_part,
                    "dest": "", "src": "", "comment": "", "isComment": True
                })
            continue

        # Line generates machine code! Parse label, mnemonic, operands, comment
        comment = ""
        code = src_part
        if ';' in src_part:
            idx = src_part.find(';')
            code = src_part[:idx].strip()
            comment = src_part[idx:].strip()

        label = ""
        if ':' in code:
            l_parts = code.split(':', 1)
            label = l_parts[0].strip() + ":"
            code = l_parts[1].strip()
            pending_label = ""
        elif pending_label:
            label = pending_label
            pending_label = ""

        tokens = code.split(None, 1)
        mnem = tokens[0].upper() if tokens else ""
        operands = tokens[1] if len(tokens) > 1 else ""
        dest = ""
        src = ""

        if operands:
            if ',' in operands:
                op_parts = operands.split(',', 1)
                dest = op_parts[0].strip() + ","
                src = op_parts[1].strip()
            else:
                dest = operands.strip()

        # Normalize hex notation (01h -> $01) for UI compatibility
        if src and re.match(r'^[0-9a-fA-F]+[hH]$', src):
            src = "$" + src[:-1].upper()
        if dest:
            has_comma = dest.endswith(',')
            d_val = dest[:-1] if has_comma else dest
            if re.match(r'^[0-9a-fA-F]+[hH]$', d_val):
                dest = "$" + d_val[:-1].upper() + ("," if has_comma else "")

        program.append({
            "addr": addr_hex,
            "bytes": bytes_part,
            "label": label,
            "mnem": mnem,
            "dest": dest,
            "src": src,
            "comment": comment
        })

    # Flatten mem_map to contiguous Intel HEX chunks
    flat_mem = {}
    for a in sorted(mem_map.keys()):
        bytes_list = mem_map[a]
        for i, b in enumerate(bytes_list):
            flat_mem[a + i] = b

    # Group contiguous blocks for Intel HEX output
    hex_blocks = {}
    current_block_start = None
    current_block_data = []

    for addr in sorted(flat_mem.keys()):
        if current_block_start is None:
            current_block_start = addr
            current_block_data = [flat_mem[addr]]
        elif addr == current_block_start + len(current_block_data):
            current_block_data.append(flat_mem[addr])
        else:
            hex_blocks[current_block_start] = current_block_data
            current_block_start = addr
            current_block_data = [flat_mem[addr]]

    if current_block_start is not None:
        hex_blocks[current_block_start] = current_block_data

    write_intel_hex(hex_path, hex_blocks)

    # Build 256-byte preview memory array for UI initial state
    start_addr_num = int(first_pc, 16) if first_pc else 0
    preview_mem = [flat_mem.get(start_addr_num + i, 0) for i in range(256)]

    import json
    out_obj = {
        "hexFile": os.path.basename(asm_path),
        "startPc": first_pc or "0000",
        "program": program,
        "memory": preview_mem
    }

    with open(json_path, "w") as f:
        json.dump(out_obj, f, indent=2)

    inst_count = len([p for p in program if p.get("bytes")])
    comment_count = len([p for p in program if p.get("isComment")])
    print(f"[ASM2JSON] Converted {asm_path} ({inst_count} instructions, {comment_count} comments/notes) -> {hex_path} & {json_path}")
    return True

def main():
    if len(sys.argv) < 2:
        print("Usage: asm_to_program.py <input.asm> [output.hex] [output.json]")
        sys.exit(1)

    asm_file = sys.argv[1]
    hex_file = sys.argv[2] if len(sys.argv) > 2 else "/tmp/rct_active.hex"
    json_file = sys.argv[3] if len(sys.argv) > 3 else "/tmp/rct_active_program.json"

    if not os.path.isfile(asm_file):
        print(f"Error: ASM file not found: {asm_file}")
        sys.exit(1)

    success = assemble_z80(asm_file, hex_file, json_file)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
