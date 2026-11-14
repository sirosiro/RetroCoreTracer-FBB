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
        elif op == 0xCB:
            cb_op = mem[pc]; pc += 1; bytes_list.append(f"{cb_op:02X}")
            r_target = r8[cb_op & 0x07]
            bit_idx = (cb_op >> 3) & 0x07
            grp = (cb_op >> 6) & 0x03
            if grp == 0:
                cb_rot = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SLL", "SRL"]
                mnem = cb_rot[bit_idx]
                dest = r_target
                comment = f"; Shift/Rotate {r_target}"
            elif grp == 1:
                mnem = "BIT"
                dest = f"{bit_idx},"
                src = r_target
                comment = f"; Test bit {bit_idx} of {r_target}"
            elif grp == 2:
                mnem = "RES"
                dest = f"{bit_idx},"
                src = r_target
                comment = f"; Reset bit {bit_idx} of {r_target}"
            else:
                mnem = "SET"
                dest = f"{bit_idx},"
                src = r_target
                comment = f"; Set bit {bit_idx} of {r_target}"
        elif op == 0xED:
            ed_op = mem[pc]; pc += 1; bytes_list.append(f"{ed_op:02X}")
            if ed_op == 0xB0:
                mnem = "LDIR"; comment = "; Load, increment and repeat: (DE) <- (HL), BC <- BC-1"
            elif ed_op == 0xB8:
                mnem = "LDDR"; comment = "; Load, decrement and repeat"
            elif ed_op == 0xA0:
                mnem = "LDI"; comment = "; Load and increment"
            elif ed_op == 0xA8:
                mnem = "LDD"; comment = "; Load and decrement"
            elif ed_op == 0xB1:
                mnem = "CPIR"; comment = "; Compare, increment and repeat: CP (HL), BC <- BC-1"
            elif ed_op == 0xB9:
                mnem = "CPDR"; comment = "; Compare, decrement and repeat"
            elif ed_op == 0xA1:
                mnem = "CPI"; comment = "; Compare and increment"
            elif ed_op == 0xA9:
                mnem = "CPD"; comment = "; Compare and decrement"
            elif ed_op in (0x44, 0x4C, 0x54, 0x5C, 0x64, 0x6C, 0x74, 0x7C):
                mnem = "NEG"; comment = "; Negate accumulator (twos complement)"
            elif ed_op == 0x46:
                mnem = "IM"; dest = "0"; comment = "; Interrupt mode 0"
            elif ed_op == 0x56:
                mnem = "IM"; dest = "1"; comment = "; Interrupt mode 1"
            elif ed_op == 0x5E:
                mnem = "IM"; dest = "2"; comment = "; Interrupt mode 2"
            elif ed_op == 0x47:
                mnem = "LD"; dest = "I,"; src = "A"; comment = "; Load I with A"
            elif ed_op == 0x4F:
                mnem = "LD"; dest = "R,"; src = "A"; comment = "; Load R with A"
            elif ed_op == 0x57:
                mnem = "LD"; dest = "A,"; src = "I"; comment = "; Load A with I"
            elif ed_op == 0x5F:
                mnem = "LD"; dest = "A,"; src = "R"; comment = "; Load A with R"
            elif ed_op == 0x67:
                mnem = "RRD"; comment = "; Rotate right decimal"
            elif ed_op == 0x6F:
                mnem = "RLD"; comment = "; Rotate left decimal"
            elif ed_op == 0x4D:
                mnem = "RETI"; comment = "; Return from interrupt"
            elif ed_op == 0x45:
                mnem = "RETN"; comment = "; Return from non-maskable interrupt"
            elif (ed_op & 0xCF) == 0x42:
                ss = r16[(ed_op >> 4) & 3]
                mnem = "SBC"; dest = "HL,"; src = ss; comment = f"; HL = HL - {ss} - C"
            elif (ed_op & 0xCF) == 0x4A:
                ss = r16[(ed_op >> 4) & 3]
                mnem = "ADC"; dest = "HL,"; src = ss; comment = f"; HL = HL + {ss} + C"
            elif (ed_op & 0xCF) == 0x43:
                dd = r16[(ed_op >> 4) & 3]
                lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
                hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
                nn = (hi << 8) | lo
                mnem = "LD"; dest = f"(${nn:04X}),"; src = dd; comment = f"; Load ({nn:04X}) with {dd}"
            elif (ed_op & 0xCF) == 0x4B:
                dd = r16[(ed_op >> 4) & 3]
                lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
                hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
                nn = (hi << 8) | lo
                mnem = "LD"; dest = f"{dd},"; src = f"(${nn:04X})"; comment = f"; Load {dd} from ({nn:04X})"
            elif (ed_op & 0xC7) == 0x40:
                r = r8[(ed_op >> 3) & 7]
                mnem = "IN"; dest = f"{r},"; src = "(C)"; comment = f"; Read port C into {r}"
            elif (ed_op & 0xC7) == 0x41:
                r = r8[(ed_op >> 3) & 7]
                mnem = "OUT"; dest = "(C),"; src = r; comment = f"; Write {r} to port C"
            elif ed_op == 0xA2:
                mnem = "INI"; comment = "; Input and increment"
            elif ed_op == 0xB2:
                mnem = "INIR"; comment = "; Input, increment and repeat"
            elif ed_op == 0xAA:
                mnem = "IND"; comment = "; Input and decrement"
            elif ed_op == 0xBA:
                mnem = "INDR"; comment = "; Input, decrement and repeat"
            elif ed_op == 0xA3:
                mnem = "OUTI"; comment = "; Output and increment"
            elif ed_op == 0xB3:
                mnem = "OTIR"; comment = "; Output, increment and repeat"
            elif ed_op == 0xAB:
                mnem = "OUTD"; comment = "; Output and decrement"
            elif ed_op == 0xBB:
                mnem = "OTDR"; comment = "; Output, decrement and repeat"
            else:
                mnem = "ED"; dest = f"${ed_op:02X}"
        elif op == 0xDD or op == 0xFD:
            reg_name = "IX" if op == 0xDD else "IY"
            sub_op = mem[pc]; pc += 1; bytes_list.append(f"{sub_op:02X}")
            if sub_op == 0xCB:
                d = mem[pc]; pc += 1; bytes_list.append(f"{d:02X}")
                cb_op = mem[pc]; pc += 1; bytes_list.append(f"{cb_op:02X}")
                disp = f"+{d}" if d < 128 else f"-{256-d}"
                target = f"({reg_name}{disp})"
                bit_idx = (cb_op >> 3) & 0x07
                grp = (cb_op >> 6) & 0x03
                if grp == 0:
                    cb_rot = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SLL", "SRL"]
                    mnem = cb_rot[bit_idx]; dest = target; comment = f"; Shift/Rotate {target}"
                elif grp == 1:
                    mnem = "BIT"; dest = f"{bit_idx},"; src = target; comment = f"; Test bit {bit_idx} of {target}"
                elif grp == 2:
                    mnem = "RES"; dest = f"{bit_idx},"; src = target; comment = f"; Reset bit {bit_idx} of {target}"
                else:
                    mnem = "SET"; dest = f"{bit_idx},"; src = target; comment = f"; Set bit {bit_idx} of {target}"
            elif sub_op == 0x21:
                lo = mem[pc]; hi = mem[pc+1]; pc += 2; bytes_list.extend([f"{lo:02X}", f"{hi:02X}"])
                val = (hi << 8) | lo; mnem = "LD"; dest = f"{reg_name},"; src = f"${val:04X}"; comment = f"; Load 16-bit immediate into {reg_name}"
            elif sub_op == 0x22:
                lo = mem[pc]; hi = mem[pc+1]; pc += 2; bytes_list.extend([f"{lo:02X}", f"{hi:02X}"])
                val = (hi << 8) | lo; mnem = "LD"; dest = f"(${val:04X}),"; src = reg_name; comment = f"; Store {reg_name} to (${val:04X})"
            elif sub_op == 0x2A:
                lo = mem[pc]; hi = mem[pc+1]; pc += 2; bytes_list.extend([f"{lo:02X}", f"{hi:02X}"])
                val = (hi << 8) | lo; mnem = "LD"; dest = f"{reg_name},"; src = f"(${val:04X})"; comment = f"; Load {reg_name} from (${val:04X})"
            elif sub_op in [0x09, 0x19, 0x29, 0x39]:
                ss = ["BC", "DE", reg_name, "SP"][(sub_op >> 4) & 3]
                mnem = "ADD"; dest = f"{reg_name},"; src = ss; comment = f"; 16-bit addition {reg_name} + {ss}"
            elif sub_op == 0x23:
                mnem = "INC"; dest = reg_name; comment = f"; Increment {reg_name}"
            elif sub_op == 0x2B:
                mnem = "DEC"; dest = reg_name; comment = f"; Decrement {reg_name}"
            elif sub_op == 0xE5:
                mnem = "PUSH"; dest = reg_name; comment = f"; Push {reg_name} to stack"
            elif sub_op == 0xE1:
                mnem = "POP"; dest = reg_name; comment = f"; Pop {reg_name} from stack"
            elif sub_op == 0xE3:
                mnem = "EX"; dest = "(SP),"; src = reg_name; comment = f"; Exchange {reg_name} with top of stack"
            elif sub_op == 0xE9:
                mnem = "JP"; dest = f"({reg_name})"; comment = f"; Jump to address in {reg_name}"
            elif sub_op == 0xF9:
                mnem = "LD"; dest = "SP,"; src = reg_name; comment = f"; Load SP from {reg_name}"
            elif sub_op == 0x34 or sub_op == 0x35:
                d = mem[pc]; pc += 1; bytes_list.append(f"{d:02X}")
                disp = f"+{d}" if d < 128 else f"-{256-d}"
                mnem = "INC" if sub_op == 0x34 else "DEC"; dest = f"({reg_name}{disp})"; comment = f"; {mnem} memory byte"
            elif sub_op == 0x36:
                d = mem[pc]; n = mem[pc+1]; pc += 2; bytes_list.extend([f"{d:02X}", f"{n:02X}"])
                disp = f"+{d}" if d < 128 else f"-{256-d}"
                mnem = "LD"; dest = f"({reg_name}{disp}),"; src = f"${n:02X}"; comment = f"; Store immediate ${n:02X} into ({reg_name}{disp})"
            elif (sub_op & 0xC7) in [0x04, 0x05]:
                reg_h = f"{reg_name}H"; reg_l = f"{reg_name}L"
                r_map = ['B', 'C', 'D', 'E', reg_h, reg_l, f"({reg_name})", 'A']
                target_reg = r_map[(sub_op >> 3) & 7]
                mnem = "INC" if (sub_op & 0x07) == 0x04 else "DEC"
                dest = target_reg; comment = f"; {mnem} {target_reg}"
            elif (sub_op & 0xC7) == 0x06:
                n = mem[pc]; pc += 1; bytes_list.append(f"{n:02X}")
                reg_h = f"{reg_name}H"; reg_l = f"{reg_name}L"
                r_map = ['B', 'C', 'D', 'E', reg_h, reg_l, f"({reg_name})", 'A']
                target_reg = r_map[(sub_op >> 3) & 7]
                mnem = "LD"; dest = f"{target_reg},"; src = f"${n:02X}"; comment = f"; Load {target_reg} with immediate ${n:02X}"
            elif (sub_op & 0xC0) == 0x40:
                if (sub_op & 7) == 6:
                    d = mem[pc]; pc += 1; bytes_list.append(f"{d:02X}")
                    disp = f"+{d}" if d < 128 else f"-{256-d}"
                    mnem = "LD"; dest = f"{r8[(sub_op >> 3) & 7]},"; src = f"({reg_name}{disp})"; comment = f"; Load from indexed memory"
                elif ((sub_op >> 3) & 7) == 6:
                    d = mem[pc]; pc += 1; bytes_list.append(f"{d:02X}")
                    disp = f"+{d}" if d < 128 else f"-{256-d}"
                    mnem = "LD"; dest = f"({reg_name}{disp}),"; src = r8[sub_op & 7]; comment = f"; Store to indexed memory"
                else:
                    reg_h = f"{reg_name}H"; reg_l = f"{reg_name}L"
                    r_map = ['B', 'C', 'D', 'E', reg_h, reg_l, f"({reg_name})", 'A']
                    mnem = "LD"; dest = f"{r_map[(sub_op >> 3) & 7]},"; src = r_map[sub_op & 7]
            elif (sub_op & 0xC0) == 0x80:
                if (sub_op & 7) == 6:
                    d = mem[pc]; pc += 1; bytes_list.append(f"{d:02X}")
                    disp = f"+{d}" if d < 128 else f"-{256-d}"
                    alu_ops = ["ADD A,", "ADC A,", "SUB", "SBC A,", "AND", "XOR", "OR", "CP"]
                    mnem = alu_ops[(sub_op >> 3) & 7]; dest = f"({reg_name}{disp})"; comment = f"; ALU with indexed memory"
                else:
                    reg_h = f"{reg_name}H"; reg_l = f"{reg_name}L"
                    r_map = ['B', 'C', 'D', 'E', reg_h, reg_l, f"({reg_name})", 'A']
                    alu_ops = ["ADD A,", "ADC A,", "SUB", "SBC A,", "AND", "XOR", "OR", "CP"]
                    mnem = alu_ops[(sub_op >> 3) & 7]; dest = r_map[sub_op & 7]
            else:
                mnem = f"{'DD' if op == 0xDD else 'FD'}"; dest = f"${sub_op:02X}"
        elif op == 0xDB:
            n = mem[pc]; pc += 1; bytes_list.append(f"{n:02X}")
            mnem = "IN"; dest = "A,"; src = f"(${n:02X})"; comment = f"; Read port 0x{n:02X} into A"
        elif op == 0xD3:
            n = mem[pc]; pc += 1; bytes_list.append(f"{n:02X}")
            mnem = "OUT"; dest = f"(${n:02X}),"; src = "A"; comment = f"; Write A to port 0x{n:02X}"
        elif op == 0xF3:
            mnem = "DI"; comment = "; Disable interrupts"
        elif op == 0xFB:
            mnem = "EI"; comment = "; Enable interrupts"
        elif op == 0x76:
            mnem = "HALT"
            comment = "; Halt CPU"
        elif op == 0x27:
            mnem = "DAA"
            comment = "; Decimal adjust accumulator"
        elif op == 0x2F:
            mnem = "CPL"
            comment = "; Invert accumulator (ones complement)"
        elif op == 0x37:
            mnem = "SCF"
            comment = "; Set carry flag (C = 1)"
        elif op == 0x3F:
            mnem = "CCF"
            comment = "; Complement carry flag"
        elif op == 0x07:
            mnem = "RLCA"
            comment = "; Rotate left circular accumulator"
        elif op == 0x0F:
            mnem = "RRCA"
            comment = "; Rotate right circular accumulator"
        elif op == 0x17:
            mnem = "RLA"
            comment = "; Rotate left accumulator through carry"
        elif op == 0x1F:
            mnem = "RRA"
            comment = "; Rotate right accumulator through carry"
        elif op == 0xEB:
            mnem = "EX"
            dest = "DE,"
            src = "HL"
            comment = "; Exchange DE and HL"
        elif op == 0x08:
            mnem = "EX"
            dest = "AF,"
            src = "AF'"
            comment = "; Exchange AF and AF'"
        elif op == 0xD9:
            mnem = "EXX"
            comment = "; Exchange BC, DE, HL with shadow registers"
        elif op == 0x0A:
            mnem = "LD"
            dest = "A,"
            src = "(BC)"
            comment = "; Load A from [BC]"
        elif op == 0x1A:
            mnem = "LD"
            dest = "A,"
            src = "(DE)"
            comment = "; Load A from [DE]"
        elif op == 0x02:
            mnem = "LD"
            dest = "(BC),"
            src = "A"
            comment = "; Store A to [BC]"
        elif op == 0x12:
            mnem = "LD"
            dest = "(DE),"
            src = "A"
            comment = "; Store A to [DE]"
        elif op == 0x36:
            n = mem[pc]; pc += 1; bytes_list.append(f"{n:02X}")
            mnem = "LD"
            dest = "(HL),"
            src = f"${n:02X}"
            comment = f"; Store 0x{n:02X} to [HL]"
        elif op == 0x32:
            lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
            hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
            val = (hi << 8) | lo
            mnem = "LD"
            dest = f"(${val:04X}),"
            src = "A"
            comment = f"; Store A to [0x{val:04X}]"
        elif op == 0x3A:
            lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
            hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
            val = (hi << 8) | lo
            mnem = "LD"
            dest = "A,"
            src = f"(${val:04X})"
            comment = f"; Load A from [0x{val:04X}]"
        elif op == 0x34:
            mnem = "INC"
            dest = "(HL)"
            comment = "; Increment byte at [HL]"
        elif op == 0x35:
            mnem = "DEC"
            dest = "(HL)"
            comment = "; Decrement byte at [HL]"
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
        elif (op & 0xF8) == 0x88:
            src_r = r8[op & 0x07]
            mnem = "ADC"
            dest = "A,"
            src = src_r
            comment = f"; A = A + {src_r} + C"
        elif (op & 0xF8) == 0x90:
            src_r = r8[op & 0x07]
            mnem = "SUB"
            dest = src_r
            comment = f"; A = A - {src_r}"
        elif (op & 0xF8) == 0x98:
            src_r = r8[op & 0x07]
            mnem = "SBC"
            dest = "A,"
            src = src_r
            comment = f"; A = A - {src_r} - C"
        elif (op & 0xF8) == 0xA0:
            src_r = r8[op & 0x07]
            mnem = "AND"
            dest = src_r
            comment = f"; A = A & {src_r}"
        elif (op & 0xF8) == 0xA8:
            src_r = r8[op & 0x07]
            mnem = "XOR"
            dest = src_r
            comment = f"; A = A ^ {src_r}"
        elif (op & 0xF8) == 0xB0:
            src_r = r8[op & 0x07]
            mnem = "OR"
            dest = src_r
            comment = f"; A = A | {src_r}"
        elif (op & 0xF8) == 0xB8:
            src_r = r8[op & 0x07]
            mnem = "CP"
            dest = src_r
            comment = f"; Compare A with {src_r}"
        elif (op & 0xC7) == 0xC6:
            alu_ops = ["ADD A,", "ADC A,", "SUB", "SBC A,", "AND", "XOR", "OR", "CP"]
            alu_name = alu_ops[(op >> 3) & 0x07]
            n = mem[pc]; pc += 1; bytes_list.append(f"{n:02X}")
            parts = alu_name.split(' ')
            mnem = parts[0]
            dest = parts[1] if len(parts) > 1 else ""
            src = f"${n:02X}"
            comment = f"; {alu_name} 0x{n:02X}"
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
        elif op == 0x22:
            lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
            hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
            val = (hi << 8) | lo
            mnem = "LD"
            dest = f"(${val:04X}),"
            src = "HL"
            comment = f"; Store HL to [0x{val:04X}]"
        elif op == 0x2A:
            lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
            hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
            val = (hi << 8) | lo
            mnem = "LD"
            dest = "HL,"
            src = f"(${val:04X})"
            comment = f"; Load HL from [0x{val:04X}]"
        elif op == 0xF9:
            mnem = "LD"
            dest = "SP,"
            src = "HL"
            comment = "; Load SP from HL"
        elif op == 0xE3:
            mnem = "EX"
            dest = "(SP),"
            src = "HL"
            comment = "; Exchange [SP] and HL"
        elif op == 0xE9:
            mnem = "JP"
            dest = "(HL)"
            comment = "; Jump to [HL]"
        elif (op & 0xCF) == 0x09:
            rp = r16[(op >> 4) & 0x03]
            mnem = "ADD"
            dest = "HL,"
            src = rp
            comment = f"; HL = HL + {rp}"
        elif (op & 0xCF) == 0x03:
            rp = r16[(op >> 4) & 0x03]
            mnem = "INC"
            dest = rp
            comment = f"; Increment {rp}"
        elif (op & 0xCF) == 0x0B:
            rp = r16[(op >> 4) & 0x03]
            mnem = "DEC"
            dest = rp
            comment = f"; Decrement {rp}"
        elif op == 0x30 or op == 0x38:
            cond = "NC," if op == 0x30 else "C,"
            e = mem[pc]; pc += 1; bytes_list.append(f"{e:02X}")
            offset = e - 256 if (e & 0x80) else e
            target = (pc + offset) & 0xFFFF
            mnem = "JR"
            dest = cond
            src = f"${target:04X}"
            comment = f"; Jump if {cond[:-1]} to 0x{target:04X}"
        elif (op & 0xC7) == 0xC7:
            p = op & 0x38
            mnem = "RST"
            dest = f"${p:02X}"
            comment = f"; Restart to 0x{p:04X}"
        elif (op & 0xC7) == 0xC2:
            cc_names = ["NZ", "Z", "NC", "C", "PO", "PE", "P", "M"]
            cond = cc_names[(op >> 3) & 0x07]
            lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
            hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
            target = (hi << 8) | lo
            mnem = "JP"
            dest = f"{cond},"
            src = f"${target:04X}"
            comment = f"; Jump if {cond} to 0x{target:04X}"
        elif (op & 0xC7) == 0xC4:
            cc_names = ["NZ", "Z", "NC", "C", "PO", "PE", "P", "M"]
            cond = cc_names[(op >> 3) & 0x07]
            lo = mem[pc]; pc += 1; bytes_list.append(f"{lo:02X}")
            hi = mem[pc]; pc += 1; bytes_list.append(f"{hi:02X}")
            target = (hi << 8) | lo
            mnem = "CALL"
            dest = f"{cond},"
            src = f"${target:04X}"
            comment = f"; Call subroutine if {cond} at 0x{target:04X}"
        elif (op & 0xC7) == 0xC0:
            cc_names = ["NZ", "Z", "NC", "C", "PO", "PE", "P", "M"]
            cond = cc_names[(op >> 3) & 0x07]
            mnem = "RET"
            dest = cond
            comment = f"; Return if {cond}"
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
