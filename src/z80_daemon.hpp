// @intent:responsibility Verilator C++ ハーネス、タイムトラベル Undo/Redo、MMIO 同期、および JSON-RPC / テレメトリデーモン
#pragma once

#include <memory>
#include <string>
#include <vector>
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

    const CpuSnapshot& current_state() const { return history_.current(); }
    const Memory& memory() const { return memory_; }

    void run_standalone_test(size_t max_steps = 15);
    void run_socket_server(const std::string& socket_path);

    void init_shm(const std::string& shm_path = "/tmp/vfpga_z80");
    void sync_mmio(const CpuSnapshot& snap);

private:
    void clock_tick();
    CpuSnapshot capture_snapshot();
    void handle_client(int client_fd);

    std::unique_ptr<Vz80_top> top_;
    Memory memory_;
    std::array<uint8_t, 256> io_ports_{};
    SnapshotHistory history_;
    uint64_t step_count_ = 0;
    uint64_t cycle_count_ = 0;
    std::vector<std::pair<uint16_t, uint8_t>> pending_mem_undo_;

    volatile uint32_t* shm_regs_ = nullptr;
    int shm_fd_ = -1;
};
