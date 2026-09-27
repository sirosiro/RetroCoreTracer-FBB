// @intent:responsibility 不変 CPU スナップショットの保持、リングバッファ管理、および Undo / Redo タイムトラベル
#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <deque>
#include <sstream>
#include <iomanip>

struct CpuSnapshot {
    uint64_t step_count = 0;
    uint64_t cycle_count = 0;
    uint16_t pc = 0;
    uint8_t opcode = 0;
    std::string executed_mnemonic = "";

    // レジスタ
    uint16_t af = 0, bc = 0, de = 0, hl = 0;
    uint16_t af_alt = 0, bc_alt = 0, de_alt = 0, hl_alt = 0;
    uint16_t ix = 0, iy = 0, sp = 0;
    uint8_t flags = 0;

    // バス信号
    uint16_t bus_addr = 0;
    uint8_t bus_din = 0;
    uint8_t bus_dout = 0;
    bool mreq_n = true;
    bool iorq_n = true;
    bool rd_n = true;
    bool wr_n = true;
    bool m1_n = true;
    bool bus_active = false;
    bool halted = false;

    // メモリ書き換え Undo ログ (addr, old_value)
    std::vector<std::pair<uint16_t, uint8_t>> memory_undo;

    std::string to_json() const {
        std::ostringstream ss;
        auto to_hex16 = [](uint16_t v) {
            std::ostringstream s;
            s << "0x" << std::uppercase << std::hex << std::setw(4) << std::setfill('0') << v;
            return s.str();
        };
        auto to_hex8 = [](uint8_t v) {
            std::ostringstream s;
            s << "0x" << std::uppercase << std::hex << std::setw(2) << std::setfill('0') << (int)v;
            return s.str();
        };

        ss << "{"
           << "\"type\":\"telemetry\","
           << "\"step\":" << step_count << ","
           << "\"cycles\":" << cycle_count << ","
           << "\"pc\":\"" << to_hex16(pc) << "\","
           << "\"opcode\":\"" << to_hex8(opcode) << "\","
           << "\"executed_mnemonic\":\"" << executed_mnemonic << "\","
           << "\"registers\":{"
           << "\"af\":\"" << to_hex16(af) << "\","
           << "\"bc\":\"" << to_hex16(bc) << "\","
           << "\"de\":\"" << to_hex16(de) << "\","
           << "\"hl\":\"" << to_hex16(hl) << "\","
           << "\"af_alt\":\"" << to_hex16(af_alt) << "\","
           << "\"bc_alt\":\"" << to_hex16(bc_alt) << "\","
           << "\"de_alt\":\"" << to_hex16(de_alt) << "\","
           << "\"hl_alt\":\"" << to_hex16(hl_alt) << "\","
           << "\"ix\":\"" << to_hex16(ix) << "\","
           << "\"iy\":\"" << to_hex16(iy) << "\","
           << "\"sp\":\"" << to_hex16(sp) << "\","
           << "\"pc\":\"" << to_hex16(pc) << "\","
           << "\"i\":\"0x00\",\"r\":\"0x00\",\"im\":0"
           << "},"
           << "\"flags\":{"
           << "\"s\":" << ((flags >> 7) & 1) << ","
           << "\"z\":" << ((flags >> 6) & 1) << ","
           << "\"h\":" << ((flags >> 4) & 1) << ","
           << "\"pv\":" << ((flags >> 2) & 1) << ","
           << "\"n\":" << ((flags >> 1) & 1) << ","
           << "\"c\":" << (flags & 1)
           << "},"
           << "\"bus\":{"
           << "\"addr\":\"" << to_hex16(bus_addr) << "\","
           << "\"data_in\":\"" << to_hex8(bus_din) << "\","
           << "\"data_out\":\"" << to_hex8(bus_dout) << "\","
           << "\"mreq_n\":" << (mreq_n ? 1 : 0) << ","
           << "\"iorq_n\":" << (iorq_n ? 1 : 0) << ","
           << "\"rd_n\":" << (rd_n ? 1 : 0) << ","
           << "\"wr_n\":" << (wr_n ? 1 : 0) << ","
           << "\"m1_n\":" << (m1_n ? 1 : 0) << ","
           << "\"active\":" << (bus_active ? 1 : 0)
           << "},"
           << "\"halted\":" << (halted ? "true" : "false")
           << "}";
        return ss.str();
    }
};

class SnapshotHistory {
public:
    explicit SnapshotHistory(size_t max_capacity = 1000)
        : max_capacity_(max_capacity) {}

    void push(const CpuSnapshot& snapshot) {
        history_.push_back(snapshot);
        if (history_.size() > max_capacity_) {
            history_.pop_front();
        }
    }

    bool can_undo() const {
        return history_.size() > 1;
    }

    CpuSnapshot undo() {
        if (!can_undo()) {
            return history_.empty() ? CpuSnapshot() : history_.back();
        }
        history_.pop_back(); // 現在のステートを除去
        return history_.back(); // 1つ前のステートを返す
    }

    const CpuSnapshot& current() const {
        static CpuSnapshot empty;
        return history_.empty() ? empty : history_.back();
    }

    size_t size() const {
        return history_.size();
    }

    void clear() {
        history_.clear();
    }

private:
    size_t max_capacity_;
    std::deque<CpuSnapshot> history_;
};
