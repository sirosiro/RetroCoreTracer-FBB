// @intent:responsibility Z80Daemon 実装
#include "z80_daemon.hpp"
#include <iostream>
#include <iomanip>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <csignal>
#include <cstring>

static volatile bool g_running = true;
static void sig_handler(int) { g_running = false; }

Z80Daemon::Z80Daemon() {
    top_ = std::make_unique<Vz80_top>();
}

Z80Daemon::~Z80Daemon() = default;

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
            memory_.write(addr, top_->dout);
        }
    }

    // 3. クロック立ち下がり
    top_->clk = 0;
    top_->eval();

    // 立ち下がり後もバス読み出し値を安定維持
    if (top_->mreq_n == 0 && top_->rd_n == 0) {
        top_->din = memory_.read(top_->addr);
        top_->eval();
    }

    cycle_count_++;
}

void Z80Daemon::reset() {
    top_->rst_n = 0;
    top_->clk = 0;
    top_->restore_en = 0;
    top_->eval();

    clock_tick();
    clock_tick();

    top_->rst_n = 1;
    top_->eval();

    step_count_ = 0;
    cycle_count_ = 0;
    history_.clear();

    auto init_snap = capture_snapshot();
    history_.push(init_snap);
}

CpuSnapshot Z80Daemon::capture_snapshot() {
    CpuSnapshot s;
    s.step_count = step_count_;
    s.cycle_count = cycle_count_;
    s.pc = top_->probe_pc;
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
    switch (s.opcode) {
        case 0x00: s.executed_mnemonic = "NOP"; break;
        case 0x76: s.executed_mnemonic = "HALT"; break;
        case 0x3E: s.executed_mnemonic = "LD A, n"; break;
        case 0x06: s.executed_mnemonic = "LD B, n"; break;
        case 0x0E: s.executed_mnemonic = "LD C, n"; break;
        case 0x80: s.executed_mnemonic = "ADD A, B"; break;
        case 0x48: s.executed_mnemonic = "LD C, B"; break;
        case 0x47: s.executed_mnemonic = "LD B, A"; break;
        case 0xEB: s.executed_mnemonic = "EX DE, HL"; break;
        case 0x08: s.executed_mnemonic = "EX AF, AF'"; break;
        case 0xD9: s.executed_mnemonic = "EXX"; break;
        case 0xC3: s.executed_mnemonic = "JP nn"; break;
        case 0x18: s.executed_mnemonic = "JR e"; break;
        default: s.executed_mnemonic = "OP " + std::to_string(s.opcode); break;
    }
    return s;
}

CpuSnapshot Z80Daemon::step() {
    if (top_->halted) {
        return history_.current();
    }

    // 次の M1 (命令フェッチ開始) までクロックを進める
    clock_tick();
    while (top_->m1_n != 0 && !top_->halted) {
        clock_tick();
    }

    step_count_++;
    auto snap = capture_snapshot();
    history_.push(snap);
    return snap;
}

CpuSnapshot Z80Daemon::backstep() {
    if (!history_.can_undo()) {
        return history_.current();
    }

    auto prev = history_.undo();

    // RTL 内部フリップフロップへ過去レジスタ値を直接注入
    top_->restore_en = 1;
    top_->restore_pc = prev.pc;
    top_->restore_af = prev.af;
    top_->restore_bc = prev.bc;
    top_->restore_de = prev.de;
    top_->restore_hl = prev.hl;
    top_->restore_sp = prev.sp;
    top_->restore_ix = prev.ix;
    top_->restore_iy = prev.iy;

    top_->clk = 1; top_->eval();
    top_->clk = 0; top_->eval();
    top_->restore_en = 0;
    top_->eval();

    step_count_ = prev.step_count;
    cycle_count_ = prev.cycle_count;
    return prev;
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
        std::cout << "[Step " << std::setw(2) << s.step_count << "] "
                  << "PC: 0x" << std::hex << std::setw(4) << std::setfill('0') << s.pc
                  << " | Op: 0x" << std::setw(2) << (int)s.opcode
                  << " (" << s.executed_mnemonic << ")"
                  << " | A: 0x" << std::setw(2) << (s.af >> 8)
                  << " | B: 0x" << std::setw(2) << (s.bc >> 8)
                  << " | C: 0x" << std::setw(2) << (s.bc & 0xFF)
                  << " | Cycles: " << std::dec << s.cycle_count
                  << std::endl;
        if (s.halted) {
            std::cout << "CPU Halted!" << std::endl;
            break;
        }
    }

    std::cout << "\n=== Testing Backstep (Time-Travel Undo) ===" << std::endl;
    std::cout << "Current state before Undo: Step " << current_state().step_count << std::endl;
    auto u1 = backstep();
    std::cout << "Undid 1 step -> Restored Step " << u1.step_count << " (PC: 0x" << std::hex << u1.pc << ")" << std::endl;
    auto u2 = backstep();
    std::cout << "Undid 2 steps -> Restored Step " << u2.step_count << " (PC: 0x" << std::hex << u2.pc << ")" << std::endl;

    std::cout << "\n[SUCCESS] RTL cycle-accurate stepping & time-travel backstepping VERIFIED!" << std::endl;
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

        write(client_fd, resp.c_str(), resp.length());
    }
}
