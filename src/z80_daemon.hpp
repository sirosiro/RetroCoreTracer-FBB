// @intent:responsibility Verilator Z80 CPU ハーネス、メモリバス同期、スナップショット記録、Undo 復元、および UNIX ソケットサーバー
#pragma once

#include <memory>
#include <string>
#include <cstdint>
#include "Vz80_top.h"
#include "memory.hpp"
#include "snapshot_history.hpp"

class Z80Daemon {
public:
    Z80Daemon();
    ~Z80Daemon();

    bool init(const std::string& hex_file = "");
    void reset();

    CpuSnapshot step();
    CpuSnapshot backstep();
    bool load_hex(const std::string& hex_path_or_content);

    void run_standalone_test(size_t max_steps = 15);
    void run_socket_server(const std::string& socket_path);

    const CpuSnapshot& current_state() const { return history_.current(); }

private:
    std::unique_ptr<Vz80_top> top_;
    Memory memory_;
    SnapshotHistory history_;
    uint64_t step_count_ = 0;
    uint64_t cycle_count_ = 0;

    void clock_tick();
    CpuSnapshot capture_snapshot();
    void handle_client(int client_fd);
};
