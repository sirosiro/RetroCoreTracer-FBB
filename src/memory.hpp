// @intent:responsibility 64KB 仮想メモリ空間の保持および Intel HEX ローダー連携
#pragma once

#include <vector>
#include <cstdint>
#include "hex_loader.hpp"

class Memory {
public:
    Memory() : mem_(65536, 0x00) {}

    uint8_t read(uint16_t addr) const {
        return mem_[addr];
    }

    void write(uint16_t addr, uint8_t val) {
        mem_[addr] = val;
    }

    bool load_hex(const std::string& path_or_content) {
        auto res = HexLoader::load(path_or_content, mem_);
        return res.success;
    }

    void clear() {
        std::fill(mem_.begin(), mem_.end(), 0x00);
    }

    const std::vector<uint8_t>& raw() const { return mem_; }

private:
    std::vector<uint8_t> mem_;
};
