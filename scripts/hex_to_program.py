import os
import sys
import json

# @intent:responsibility Parse Intel HEX files and disassemble standard Z80 instructions into structured JSON for F-BB Web Dashboard Code View.

def parse_intel_hex(hex_path):
    mem = bytearray(65536)
    base_addr = 0
    min_addr = 0xFFFF
    max_addr = 0
    has_data = False
    with open(hex_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line.startswith(':'): continue
            length = int(line[1:3], 16)
            addr = int(line[3:7], 16) + base_addr
            rec_type = int(line[7:9], 16)
            if rec_type == 0x00:
                has_data = True
                if addr < min_addr: min_addr = addr
                for b in range(length):
                    byte_val = int(line[9 + b*2 : 11 + b*2], 16)
                    target = addr + b
                    if target < 65536:
                        mem[target] = byte_val
                        if target > max_addr: max_addr = target
            elif rec_type == 0x01: break
            elif rec_type == 0x02:
                base_addr = int(line[9:13], 16) << 4
            elif rec_type == 0x04:
                base_addr = int(line[9:13], 16) << 16
    return mem, min_addr if has_data else 0, max_addr if has_data else 0

def disassemble_z80(mem, min_addr, max_addr):
    program = []
    pc = min_addr
    r8 = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A']
    r16 = ['BC', 'DE', 'HL', 'SP']
    r16_push = ['BC', 'DE', 'HL', 'AF']

    while pc <= max_addr:
        addr_str = f"{pc:04X}"
        addr_num = pc
        op = mem[pc]
        pc += 1
        bytes_list = [f"{op:02X}"]
        label = "START:" if addr_num == min_addr else ""
        mnem = ""
        dest = ""
        src = ""
        comment = ""

        if op == 0x00:
            mnem = "NOP"
            comment = "; No operation"
        elif op == 0x76:
            mnem = "HALT"
            comment = "; Halt CPU"
        elif op == 0xC9:
            mnem = "RET"
            comment = "; Return from subroutine"
        elif (op & 0xC7) == 0x06:
            r = r8[(op >> 3) & 0x07]
            n = mem[pc]; pc += 1; bytes_list.append(f"{n:02X}")
            mnem = "LD"
            dest = f"{r},"
            src = f"${n:02X}"
            comment = f"; Load {r} with 0x{n:02X}"
        elif (op & 0xCF) == 0x01:
            rp = r16[(op >> 4) & 0x03]
            lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
            hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
            val = (hi << 8) | lo
            mnem = "LD"
            dest = f"{rp},"
            src = f"${val:04X}"
            comment = f"; Load {rp} with 0x{val:04X}"
        elif (op & 0xC0) == 0x40 and op != 0x76:
            dst_r = r8[(op >> 3) & 0x07]
            src_r = r8[op & 0x07]
            mnem = "LD"
            dest = f"{dst_r},"
            src = f"{src_r}"
            comment = f"; Copy {src_r} to {dst_r}"
        elif (op & 0xF8) == 0x80:
            src_r = r8[op & 0x07]
            mnem = "ADD"
            dest = "A,"
            src = src_r
            comment = f"; A = A + {src_r}"
        elif (op & 0xF8) == 0x90:
            src_r = r8[op & 0x07]
            mnem = "SUB"
            dest = src_r
            comment = f"; A = A - {src_r}"
        elif (op & 0xC7) == 0x04:
            r = r8[(op >> 3) & 0x07]
            mnem = "INC"
            dest = r
            comment = f"; Increment {r}"
        elif (op & 0xC7) == 0x05:
            r = r8[(op >> 3) & 0x07]
            mnem = "DEC"
            dest = r
            comment = f"; Decrement {r}"
        elif op == 0x10:
            e = mem[pc]; pc += 1; bytes_list.append(f"{e:02X}")
            offset = e - 256 if (e & 0x80) else e
            target = (pc + offset) & 0xFFFF
            mnem = "DJNZ"
            dest = f"${target:04X}"
            src = f"({offset})"
            comment = f"; Decrement B, jump if != 0 to 0x{target:04X}"
        elif op == 0x18:
            e = mem[pc]; pc += 1; bytes_list.append(f"{e:02X}")
            offset = e - 256 if (e & 0x80) else e
            target = (pc + offset) & 0xFFFF
            mnem = "JR"
            dest = f"${target:04X}"
            src = f"({offset})"
            comment = f"; Relative jump to 0x{target:04X}"
        elif op == 0x20 or op == 0x28:
            cond = "NZ," if op == 0x20 else "Z,"
            e = mem[pc]; pc += 1; bytes_list.append(f"{e:02X}")
            offset = e - 256 if (e & 0x80) else e
            target = (pc + offset) & 0xFFFF
            mnem = "JR"
            dest = cond
            src = f"${target:04X}"
            comment = f"; Jump if {cond[:-1]} to 0x{target:04X}"
        elif op == 0xC3:
            lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
            hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
            target = (hi << 8) | lo
            mnem = "JP"
            dest = f"${target:04X}"
            comment = f"; Jump to 0x{target:04X}"
        elif op == 0xCD:
            lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
            hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
            target = (hi << 8) | lo
            mnem = "CALL"
            dest = f"${target:04X}"
            comment = f"; Call subroutine at 0x{target:04X}"
        elif (op & 0xCF) == 0xC5:
            rp = r16_push[(op >> 4) & 0x03]
            mnem = "PUSH"
            dest = rp
            comment = f"; Push {rp} onto stack"
        elif (op & 0xCF) == 0xC1:
            rp = r16_push[(op >> 4) & 0x03]
            mnem = "POP"
            dest = rp
            comment = f"; Pop {rp} from stack"
        else:
            mnem = "DB"
            dest = f"${op:02X}"

        program.append({
            "addr": addr_str,
            "bytes": " ".join(bytes_list),
            "label": label,
            "mnem": mnem,
            "dest": dest,
            "src": src,
            "comment": comment
        })

    return program

def main():
    if len(sys.argv) < 3:
        print("Usage: hex_to_program.py <input.hex> <output.json>")
        sys.exit(1)

    hex_path = sys.argv[1]
    out_path = sys.argv[2]

    if not os.path.exists(hex_path):
        print(f"Error: HEX file not found: {hex_path}")
        sys.exit(1)

    mem, min_a, max_a = parse_intel_hex(hex_path)
    prog = disassemble_z80(mem, min_a, max_a)

    result = {
        "hexFile": os.path.basename(hex_path),
        "startPc": f"{min_a:04X}",
        "program": prog,
        "memory": list(mem[:max_a + 16])
    }

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)

    print(f"[HEX2JSON] Converted {hex_path} ({len(prog)} instructions) -> {out_path}")

if __name__ == "__main__":
    main()
