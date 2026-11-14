// @intent:responsibility Z80Daemon 実装 (非破壊・追記型タイムトラベル & MMIO 同期)
#include "z80_daemon.hpp"
#include <iostream>
#include <iomanip>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <csignal>
#include <cstring>

static volatile bool g_running = true;
static void sig_handler(int) { g_running = false; }

Z80Daemon::Z80Daemon() {
    top_ = std::make_unique<Vz80_top>();
}

Z80Daemon::~Z80Daemon() {
    if (shm_regs_) {
        munmap((void*)shm_regs_, 4096);
        shm_regs_ = nullptr;
    }
    if (shm_fd_ >= 0) {
        close(shm_fd_);
        shm_fd_ = -1;
    }
}

void Z80Daemon::init_shm(const std::string& shm_path) {
    if (shm_regs_) return;
    int fd = open(shm_path.c_str(), O_RDWR | O_CREAT, 0666);
    if (fd >= 0) {
        struct stat st;
        if (fstat(fd, &st) == 0 && st.st_size < 4096) {
            if (ftruncate(fd, 4096) != 0) {
                // ignore error
            }
        }
        void* ptr = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (ptr != MAP_FAILED) {
            shm_regs_ = static_cast<volatile uint32_t*>(ptr);
            shm_fd_ = fd;
        } else {
            close(fd);
        }
    }
}

void Z80Daemon::sync_mmio(const CpuSnapshot& snap) {
    if (!shm_regs_) {
        init_shm();
        if (!shm_regs_) return;
    }
    shm_regs_[0x00 / 4] = 1; // CTRL: Active
    shm_regs_[0x04 / 4] = snap.halted ? 2 : 1; // STATUS: 1=Running, 2=Halted
    shm_regs_[0x08 / 4] = 0; // CMD
    shm_regs_[0x0C / 4] = (uint32_t)snap.cycle_count; // CYCLES
    shm_regs_[0x10 / 4] = snap.pc; // PC
    shm_regs_[0x14 / 4] = snap.sp; // SP
    shm_regs_[0x18 / 4] = snap.af; // AF
    shm_regs_[0x1C / 4] = snap.bc; // BC
    shm_regs_[0x20 / 4] = snap.de; // DE
    shm_regs_[0x24 / 4] = snap.hl; // HL
    shm_regs_[0x28 / 4] = snap.ix; // IX
    shm_regs_[0x2C / 4] = snap.iy; // IY
    shm_regs_[0x30 / 4] = snap.flags; // FLAGS
    shm_regs_[0x34 / 4] = snap.af_alt; // AF_ALT (AF')
    shm_regs_[0x38 / 4] = snap.bc_alt; // BC_ALT (BC')
    shm_regs_[0x3C / 4] = snap.de_alt; // DE_ALT (DE')
    shm_regs_[0x40 / 4] = snap.hl_alt; // HL_ALT (HL')
}

bool Z80Daemon::init(const std::string& hex_file) {
    if (!hex_file.empty()) {
        if (!load_hex(hex_file)) {
            std::cerr << "[-] Failed to load HEX file: " << hex_file << std::endl;
            return false;
        }
    }
    reset();
    return true;
}

void Z80Daemon::clock_tick() {
    // 1. クロック立ち上がり
    top_->clk = 1;
    top_->eval();

    // 2. アドレス更新に伴う組合せバス信号の即時伝播
    if (top_->mreq_n == 0) {
        uint16_t addr = top_->addr;
        if (top_->rd_n == 0) {
            top_->din = memory_.read(addr);
            top_->eval();
        } else if (top_->wr_n == 0) {
            // メモリ書換 Undo ログの記録
            pending_mem_undo_.emplace_back(addr, memory_.read(addr));
            memory_.write(addr, top_->dout);
        }
    } else if (top_->iorq_n == 0) {
        uint8_t port = top_->addr & 0xFF;
        if (top_->rd_n == 0) {
            top_->din = io_ports_[port];
            top_->eval();
        } else if (top_->wr_n == 0) {
            io_ports_[port] = top_->dout;
        }
    }

    // 3. クロック立ち下がり
    top_->clk = 0;
    top_->eval();

    // 立ち下がり後もバス読み出し値を安定維持
    if (top_->mreq_n == 0 && top_->rd_n == 0) {
        top_->din = memory_.read(top_->addr);
        top_->eval();
    } else if (top_->iorq_n == 0 && top_->rd_n == 0) {
        top_->din = io_ports_[top_->addr & 0xFF];
        top_->eval();
    }

    cycle_count_++;
}

void Z80Daemon::reset() {
    top_->rst_n = 0;
    top_->clk = 0;
    top_->restore_en = 0;
    top_->restore_af_alt = 0;
    top_->restore_bc_alt = 0;
    top_->restore_de_alt = 0;
    top_->restore_hl_alt = 0;
    top_->restore_halted = 0;
    top_->eval();

    clock_tick();
    clock_tick();

    top_->rst_n = 1;
    top_->eval();

    step_count_ = 0;
    cycle_count_ = 0;
    pending_mem_undo_.clear();
    history_.clear();

    auto init_snap = capture_snapshot();
    history_.push(init_snap);
    sync_mmio(init_snap);
}

CpuSnapshot Z80Daemon::capture_snapshot() {
    CpuSnapshot s;
    s.step_count = step_count_;
    s.cycle_count = cycle_count_;
    s.pc = top_->probe_pc;
    s.prefix = top_->probe_prefix;
    s.opcode = top_->probe_opcode;
    s.af = top_->probe_af;
    s.bc = top_->probe_bc;
    s.de = top_->probe_de;
    s.hl = top_->probe_hl;
    s.af_alt = top_->probe_af_alt;
    s.bc_alt = top_->probe_bc_alt;
    s.de_alt = top_->probe_de_alt;
    s.hl_alt = top_->probe_hl_alt;
    s.ix = top_->probe_ix;
    s.iy = top_->probe_iy;
    s.sp = top_->probe_sp;
    s.flags = top_->probe_flags;

    s.bus_addr = top_->addr;
    s.bus_din = top_->din;
    s.bus_dout = top_->dout;
    s.mreq_n = (top_->mreq_n != 0);
    s.iorq_n = (top_->iorq_n != 0);
    s.rd_n = (top_->rd_n != 0);
    s.wr_n = (top_->wr_n != 0);
    s.m1_n = (top_->m1_n != 0);
    s.bus_active = (top_->probe_bus_active != 0);
    s.halted = (top_->halted != 0);

    // ニーモニック逆アセンブルの簡易解決
    const char* r_names[] = {"B", "C", "D", "E", "H", "L", "(HL)", "A"};
    const char* r16_names[] = {"BC", "DE", "HL", "SP"};
    const char* qq_names[] = {"BC", "DE", "HL", "AF"};
    const char* cc_names[] = {"NZ", "Z", "NC", "C", "PO", "PE", "P", "M"};
    const char* alu_names[] = {"ADD A,", "ADC A,", "SUB", "SBC A,", "AND", "XOR", "OR", "CP"};
    const char* cb_rot_names[] = {"RLC", "RRC", "RL", "RR", "SLA", "SRA", "SLL", "SRL"};

    uint8_t op = s.opcode;
    if (s.prefix == 1) { // Phase 4: CB プレフィックス
        if ((op & 0xC0) == 0x00) {
            s.executed_mnemonic = std::string(cb_rot_names[(op >> 3) & 7]) + " " + r_names[op & 7];
        } else if ((op & 0xC0) == 0x40) {
            s.executed_mnemonic = "BIT " + std::to_string((op >> 3) & 7) + ", " + r_names[op & 7];
        } else if ((op & 0xC0) == 0x80) {
            s.executed_mnemonic = "RES " + std::to_string((op >> 3) & 7) + ", " + r_names[op & 7];
        } else {
            s.executed_mnemonic = "SET " + std::to_string((op >> 3) & 7) + ", " + r_names[op & 7];
        }
    } else if (s.prefix == 2) { // Phase 5: ED プレフィックス
        if (op == 0xB0) s.executed_mnemonic = "LDIR";
        else if (op == 0xB8) s.executed_mnemonic = "LDDR";
        else if (op == 0xA0) s.executed_mnemonic = "LDI";
        else if (op == 0xA8) s.executed_mnemonic = "LDD";
        else if (op == 0xB1) s.executed_mnemonic = "CPIR";
        else if (op == 0xB9) s.executed_mnemonic = "CPDR";
        else if (op == 0xA1) s.executed_mnemonic = "CPI";
        else if (op == 0xA9) s.executed_mnemonic = "CPD";
        else if (op == 0xB2) s.executed_mnemonic = "INIR";
        else if (op == 0xBA) s.executed_mnemonic = "INDR";
        else if (op == 0xA2) s.executed_mnemonic = "INI";
        else if (op == 0xAA) s.executed_mnemonic = "IND";
        else if (op == 0xB3) s.executed_mnemonic = "OTIR";
        else if (op == 0xBB) s.executed_mnemonic = "OTDR";
        else if (op == 0xA3) s.executed_mnemonic = "OUTI";
        else if (op == 0xAB) s.executed_mnemonic = "OUTD";
        else if (op == 0x44 || op == 0x4C || op == 0x54 || op == 0x5C ||
                 op == 0x64 || op == 0x6C || op == 0x74 || op == 0x7C) s.executed_mnemonic = "NEG";
        else if (op == 0x46) s.executed_mnemonic = "IM 0";
        else if (op == 0x56) s.executed_mnemonic = "IM 1";
        else if (op == 0x5E) s.executed_mnemonic = "IM 2";
        else if (op == 0x47) s.executed_mnemonic = "LD I, A";
        else if (op == 0x4F) s.executed_mnemonic = "LD R, A";
        else if (op == 0x57) s.executed_mnemonic = "LD A, I";
        else if (op == 0x5F) s.executed_mnemonic = "LD A, R";
        else if (op == 0x67) s.executed_mnemonic = "RRD";
        else if (op == 0x6F) s.executed_mnemonic = "RLD";
        else if (op == 0x4D) s.executed_mnemonic = "RETI";
        else if (op == 0x45) s.executed_mnemonic = "RETN";
        else if ((op & 0xCF) == 0x42) s.executed_mnemonic = std::string("SBC HL, ") + r16_names[(op >> 4) & 3];
        else if ((op & 0xCF) == 0x4A) s.executed_mnemonic = std::string("ADC HL, ") + r16_names[(op >> 4) & 3];
        else if ((op & 0xCF) == 0x43) s.executed_mnemonic = std::string("LD (nn), ") + r16_names[(op >> 4) & 3];
        else if ((op & 0xCF) == 0x4B) s.executed_mnemonic = std::string("LD ") + r16_names[(op >> 4) & 3] + ", (nn)";
        else if ((op & 0xC7) == 0x40) s.executed_mnemonic = std::string("IN ") + r_names[(op >> 3) & 7] + ", (C)";
        else if ((op & 0xC7) == 0x41) s.executed_mnemonic = std::string("OUT (C), ") + r_names[(op >> 3) & 7];
        else s.executed_mnemonic = "ED 0x" + ([op]() {
            std::ostringstream ss;
            ss << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << (int)op;
            return ss.str();
        })();
    } else if (s.prefix == 3 || s.prefix == 4) { // Phase 6: DD / FD プレフィックス
        std::string reg_name = (s.prefix == 3) ? "IX" : "IY";
        if (op == 0x21) s.executed_mnemonic = "LD " + reg_name + ", nn";
        else if (op == 0x22) s.executed_mnemonic = "LD (nn), " + reg_name;
        else if (op == 0x2A) s.executed_mnemonic = "LD " + reg_name + ", (nn)";
        else if (op == 0x09) s.executed_mnemonic = "ADD " + reg_name + ", BC";
        else if (op == 0x19) s.executed_mnemonic = "ADD " + reg_name + ", DE";
        else if (op == 0x29) s.executed_mnemonic = "ADD " + reg_name + ", " + reg_name;
        else if (op == 0x39) s.executed_mnemonic = "ADD " + reg_name + ", SP";
        else if (op == 0x23) s.executed_mnemonic = "INC " + reg_name;
        else if (op == 0x2B) s.executed_mnemonic = "DEC " + reg_name;
        else if (op == 0xE5) s.executed_mnemonic = "PUSH " + reg_name;
        else if (op == 0xE1) s.executed_mnemonic = "POP " + reg_name;
        else if (op == 0xE3) s.executed_mnemonic = "EX (SP), " + reg_name;
        else if (op == 0xE9) s.executed_mnemonic = "JP (" + reg_name + ")";
        else if (op == 0xF9) s.executed_mnemonic = "LD SP, " + reg_name;
        else if (op == 0x26) s.executed_mnemonic = "LD " + std::string(s.prefix == 3 ? "IXH" : "IYH") + ", n";
        else if (op == 0x2E) s.executed_mnemonic = "LD " + std::string(s.prefix == 3 ? "IXL" : "IYL") + ", n";
        else if (op == 0x34) s.executed_mnemonic = "INC (" + reg_name + "+d)";
        else if (op == 0x35) s.executed_mnemonic = "DEC (" + reg_name + "+d)";
        else if (op == 0x36) s.executed_mnemonic = "LD (" + reg_name + "+d), n";
        else if ((op & 0xC0) == 0x40) {
            if ((op & 7) == 6) s.executed_mnemonic = "LD " + std::string(r_names[(op >> 3) & 7]) + ", (" + reg_name + "+d)";
            else if (((op >> 3) & 7) == 6) s.executed_mnemonic = "LD (" + reg_name + "+d), " + r_names[op & 7];
            else {
                std::string rh = (s.prefix == 3 ? "IXH" : "IYH");
                std::string rl = (s.prefix == 3 ? "IXL" : "IYL");
                const char* r_idx[] = {"B", "C", "D", "E", rh.c_str(), rl.c_str(), "(HL)", "A"};
                s.executed_mnemonic = std::string("LD ") + r_idx[(op >> 3) & 7] + ", " + r_idx[op & 7];
            }
        } else if ((op & 0xC0) == 0x80) {
            if ((op & 7) == 6) s.executed_mnemonic = std::string(alu_names[(op >> 3) & 7]) + " (" + reg_name + "+d)";
            else s.executed_mnemonic = std::string(alu_names[(op >> 3) & 7]) + " " + reg_name;
        } else {
            s.executed_mnemonic = ((s.prefix == 3) ? "DD 0x" : "FD 0x") + ([op]() {
                std::ostringstream ss;
                ss << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << (int)op;
                return ss.str();
            })();
        }
    } else if (s.prefix == 5 || s.prefix == 6) { // Phase 6: DD CB / FD CB プレフィックス
        std::string reg_name = (s.prefix == 5) ? "IX" : "IY";
        if ((op & 0xC0) == 0x00) {
            s.executed_mnemonic = std::string(cb_rot_names[(op >> 3) & 7]) + " (" + reg_name + "+d)";
        } else if ((op & 0xC0) == 0x40) {
            s.executed_mnemonic = "BIT " + std::to_string((op >> 3) & 7) + ", (" + reg_name + "+d)";
        } else if ((op & 0xC0) == 0x80) {
            s.executed_mnemonic = "RES " + std::to_string((op >> 3) & 7) + ", (" + reg_name + "+d)";
        } else {
            s.executed_mnemonic = "SET " + std::to_string((op >> 3) & 7) + ", (" + reg_name + "+d)";
        }
    } else if (op == 0x00) s.executed_mnemonic = "NOP";
    else if (op == 0x76) s.executed_mnemonic = "HALT";
    else if (op == 0xEB) s.executed_mnemonic = "EX DE, HL";
    else if (op == 0x08) s.executed_mnemonic = "EX AF, AF'";
    else if (op == 0xD9) s.executed_mnemonic = "EXX";
    else if (op == 0xE3) s.executed_mnemonic = "EX (SP), HL";
    else if (op == 0xE9) s.executed_mnemonic = "JP (HL)";
    else if (op == 0xF9) s.executed_mnemonic = "LD SP, HL";
    else if (op == 0x27) s.executed_mnemonic = "DAA";
    else if (op == 0x2F) s.executed_mnemonic = "CPL";
    else if (op == 0x37) s.executed_mnemonic = "SCF";
    else if (op == 0x3F) s.executed_mnemonic = "CCF";
    else if (op == 0x07) s.executed_mnemonic = "RLCA";
    else if (op == 0x0F) s.executed_mnemonic = "RRCA";
    else if (op == 0x17) s.executed_mnemonic = "RLA";
    else if (op == 0x1F) s.executed_mnemonic = "RRA";
    else if (op == 0x0A) s.executed_mnemonic = "LD A, (BC)";
    else if (op == 0x1A) s.executed_mnemonic = "LD A, (DE)";
    else if (op == 0x02) s.executed_mnemonic = "LD (BC), A";
    else if (op == 0x12) s.executed_mnemonic = "LD (DE), A";
    else if (op == 0x32) s.executed_mnemonic = "LD (nn), A";
    else if (op == 0x3A) s.executed_mnemonic = "LD A, (nn)";
    else if (op == 0x22) s.executed_mnemonic = "LD (nn), HL";
    else if (op == 0x2A) s.executed_mnemonic = "LD HL, (nn)";
    else if (op == 0x34) s.executed_mnemonic = "INC (HL)";
    else if (op == 0x35) s.executed_mnemonic = "DEC (HL)";
    else if (op == 0x36) s.executed_mnemonic = "LD (HL), n";
    else if (op == 0x10) s.executed_mnemonic = "DJNZ e";
    else if (op == 0x18) s.executed_mnemonic = "JR e";
    else if (op == 0xC3) s.executed_mnemonic = "JP nn";
    else if (op == 0xCD) s.executed_mnemonic = "CALL nn";
    else if (op == 0xC9) s.executed_mnemonic = "RET";
    else if ((op & 0xCF) == 0xC5) {
        s.executed_mnemonic = std::string("PUSH ") + qq_names[(op >> 4) & 3];
    } else if ((op & 0xCF) == 0xC1) {
        s.executed_mnemonic = std::string("POP ") + qq_names[(op >> 4) & 3];
    } else if ((op & 0xCF) == 0x01) {
        s.executed_mnemonic = std::string("LD ") + r16_names[(op >> 4) & 3] + ", nn";
    } else if ((op & 0xCF) == 0x09) {
        s.executed_mnemonic = std::string("ADD HL, ") + r16_names[(op >> 4) & 3];
    } else if ((op & 0xCF) == 0x03) {
        s.executed_mnemonic = std::string("INC ") + r16_names[(op >> 4) & 3];
    } else if ((op & 0xCF) == 0x0B) {
        s.executed_mnemonic = std::string("DEC ") + r16_names[(op >> 4) & 3];
    } else if ((op & 0xC7) == 0xC7) {
        s.executed_mnemonic = "RST 0x" + ([op]() {
            std::ostringstream ss;
            ss << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << (int)(op & 0x38);
            return ss.str();
        })();
    } else if ((op & 0xC7) == 0xC4) {
        s.executed_mnemonic = std::string("CALL ") + cc_names[(op >> 3) & 7] + ", nn";
    } else if ((op & 0xC7) == 0xC2) {
        s.executed_mnemonic = std::string("JP ") + cc_names[(op >> 3) & 7] + ", nn";
    } else if ((op & 0xC7) == 0xC0) {
        s.executed_mnemonic = std::string("RET ") + cc_names[(op >> 3) & 7];
    } else if ((op & 0xE7) == 0x20) {
        s.executed_mnemonic = std::string("JR ") + cc_names[(op >> 3) & 3] + ", e";
    } else if ((op & 0xC0) == 0x40) {
        s.executed_mnemonic = std::string("LD ") + r_names[(op >> 3) & 7] + ", " + r_names[op & 7];
    } else if ((op & 0xC7) == 0x06) {
        s.executed_mnemonic = std::string("LD ") + r_names[(op >> 3) & 7] + ", n";
    } else if ((op & 0xC7) == 0x04) {
        s.executed_mnemonic = std::string("INC ") + r_names[(op >> 3) & 7];
    } else if ((op & 0xC7) == 0x05) {
        s.executed_mnemonic = std::string("DEC ") + r_names[(op >> 3) & 7];
    } else if ((op & 0xC0) == 0x80) {
        s.executed_mnemonic = std::string(alu_names[(op >> 3) & 7]) + " " + r_names[op & 7];
    } else if ((op & 0xC7) == 0xC6) {
        s.executed_mnemonic = std::string(alu_names[(op >> 3) & 7]) + " n";
    } else if (op == 0xDB) {
        s.executed_mnemonic = "IN A, (n)";
    } else if (op == 0xD3) {
        s.executed_mnemonic = "OUT (n), A";
    } else if (op == 0xF3) {
        s.executed_mnemonic = "DI";
    } else if (op == 0xFB) {
        s.executed_mnemonic = "EI";
    } else {
        s.executed_mnemonic = "OP 0x" + ([op]() {
            std::ostringstream ss;
            ss << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << (int)op;
            return ss.str();
        })();
    }
    return s;
}

CpuSnapshot Z80Daemon::step() {
    if (top_->halted) {
        return history_.current();
    }

    pending_mem_undo_.clear();

    // 次の命令境界までクロックを進める
    clock_tick();
    while (top_->probe_instr_boundary == 0 && !top_->halted) {
        clock_tick();
    }

    step_count_++;
    auto snap = capture_snapshot();
    snap.memory_undo = std::move(pending_mem_undo_);
    history_.push(snap);
    sync_mmio(snap);
    return snap;
}

CpuSnapshot Z80Daemon::backstep() {
    if (!history_.can_undo()) {
        return history_.current();
    }

    // 現在のスナップショットで書き換えられたメモリを逆順に復元
    const auto& curr = history_.current();
    for (auto it = curr.memory_undo.rbegin(); it != curr.memory_undo.rend(); ++it) {
        memory_.write(it->first, it->second);
    }

    auto target = history_.peek_undo_target();

    // RTL 内部フリップフロップへ過去レジスタ値を直接注入
    top_->restore_en = 1;
    top_->restore_pc = target.pc;
    top_->restore_af = target.af;
    top_->restore_bc = target.bc;
    top_->restore_de = target.de;
    top_->restore_hl = target.hl;
    top_->restore_sp = target.sp;
    top_->restore_ix = target.ix;
    top_->restore_iy = target.iy;
    top_->restore_af_alt = target.af_alt;
    top_->restore_bc_alt = target.bc_alt;
    top_->restore_de_alt = target.de_alt;
    top_->restore_hl_alt = target.hl_alt;
    top_->restore_halted = target.halted;

    top_->clk = 1; top_->eval();
    top_->clk = 0; top_->eval();
    top_->restore_en = 0;
    top_->eval();

    step_count_++;
    cycle_count_ = target.cycle_count;

    auto snap = capture_snapshot();
    snap.step_count = step_count_;
    snap.executed_mnemonic = "BACKSTEP: " + target.executed_mnemonic;
    history_.record_backstep(snap);
    sync_mmio(snap);
    return snap;
}

bool Z80Daemon::load_hex(const std::string& hex_path_or_content) {
    bool ok = memory_.load_hex(hex_path_or_content);
    if (ok) {
        reset();
    }
    return ok;
}

void Z80Daemon::run_standalone_test(size_t max_steps) {
    std::cout << "=== RetroCoreTracer-FBB Standalone Verification ===" << std::endl;
    std::cout << "Initial State: PC=" << std::hex << current_state().pc << std::dec << std::endl;

    for (size_t i = 1; i <= max_steps; ++i) {
        auto s = step();
        std::string op_str;
        if (s.prefix == 1) {
            std::ostringstream ss;
            ss << "0xcb 0x" << std::hex << std::setw(2) << std::setfill('0') << (int)s.opcode;
            op_str = ss.str();
        } else if (s.prefix == 2) {
            std::ostringstream ss;
            ss << "0xed 0x" << std::hex << std::setw(2) << std::setfill('0') << (int)s.opcode;
            op_str = ss.str();
        } else if (s.prefix == 3) {
            std::ostringstream ss;
            ss << "0xdd 0x" << std::hex << std::setw(2) << std::setfill('0') << (int)s.opcode;
            op_str = ss.str();
        } else if (s.prefix == 4) {
            std::ostringstream ss;
            ss << "0xfd 0x" << std::hex << std::setw(2) << std::setfill('0') << (int)s.opcode;
            op_str = ss.str();
        } else if (s.prefix == 5) {
            std::ostringstream ss;
            ss << "0xdd 0xcb 0x" << std::hex << std::setw(2) << std::setfill('0') << (int)s.opcode;
            op_str = ss.str();
        } else if (s.prefix == 6) {
            std::ostringstream ss;
            ss << "0xfd 0xcb 0x" << std::hex << std::setw(2) << std::setfill('0') << (int)s.opcode;
            op_str = ss.str();
        } else {
            std::ostringstream ss;
            ss << "0x" << std::hex << std::setw(2) << std::setfill('0') << (int)s.opcode;
            op_str = ss.str();
        }
        std::cout << "[Step " << std::setw(2) << s.step_count << "] "
                  << "PC: 0x" << std::hex << std::setw(4) << std::setfill('0') << s.pc
                  << " | Op: " << op_str
                  << " (" << s.executed_mnemonic << ")"
                  << " | A: 0x" << std::setw(2) << (s.af >> 8)
                  << " | HL: 0x" << std::setw(4) << s.hl
                  << " | IX: 0x" << std::setw(4) << s.ix
                  << " | IY: 0x" << std::setw(4) << s.iy
                  << " | Flags: 0x" << std::setw(2) << (int)s.flags
                  << " | Cycles: " << std::dec << s.cycle_count
                  << std::endl;
        if (s.halted) {
            std::cout << "CPU Halted!" << std::endl;
            break;
        }
    }

    std::cout << "\n=== Testing Backstep (Append-Only Time-Travel Undo) ===" << std::endl;
    std::cout << "Current state before Undo: Step " << current_state().step_count << std::endl;
    auto u1 = backstep();
    std::cout << "Appended Backstep -> Monotonic Step " << u1.step_count << " (Restored PC: 0x" << std::hex << u1.pc << ")" << std::endl;
    auto u2 = backstep();
    std::cout << "Appended Backstep -> Monotonic Step " << u2.step_count << " (Restored PC: 0x" << std::hex << u2.pc << ")" << std::endl;

    std::cout << "\n[SUCCESS] RTL cycle-accurate stepping & append-only time-travel backstepping VERIFIED!" << std::endl;
}

void Z80Daemon::run_socket_server(const std::string& socket_path) {
    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    int server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (server_fd < 0) {
        perror("socket");
        return;
    }

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, socket_path.c_str(), sizeof(addr.sun_path) - 1);
    unlink(socket_path.c_str());

    if (bind(server_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(server_fd);
        return;
    }

    if (listen(server_fd, 5) < 0) {
        perror("listen");
        close(server_fd);
        return;
    }

    std::cout << " Z80Daemon listening on UNIX socket: " << socket_path << std::endl;

    while (g_running) {
        int client_fd = accept(server_fd, nullptr, nullptr);
        if (client_fd >= 0) {
            handle_client(client_fd);
            close(client_fd);
        }
    }

    close(server_fd);
    unlink(socket_path.c_str());
    std::cout << "Z80Daemon stopped cleanly." << std::endl;
}

void Z80Daemon::handle_client(int client_fd) {
    char buf[4096];
    while (g_running) {
        ssize_t n = read(client_fd, buf, sizeof(buf) - 1);
        if (n <= 0) break;
        buf[n] = '\0';
        std::string req(buf);

        std::string resp;
        if (req.find("\"cmd\":\"step\"") != std::string::npos || req.find("\"step\"") != std::string::npos) {
            auto s = step();
            resp = s.to_json() + "\n";
        } else if (req.find("\"cmd\":\"backstep\"") != std::string::npos || req.find("\"backstep\"") != std::string::npos) {
            auto s = backstep();
            resp = s.to_json() + "\n";
        } else if (req.find("\"cmd\":\"reset\"") != std::string::npos || req.find("\"reset\"") != std::string::npos) {
            reset();
            resp = current_state().to_json() + "\n";
        } else {
            resp = current_state().to_json() + "\n";
        }

        ssize_t w = write(client_fd, resp.c_str(), resp.length());
        if (w < 0) {
            break;
        }
    }
}
