// @intent:responsibility Intel HEX 形式ファイルのパースおよび 64KB メモリ空間へのロード
#pragma once

#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <fstream>
#include <cstdint>
#include <iostream>

class HexLoader {
public:
    struct Result {
        bool success = false;
        uint16_t min_addr = 0xFFFF;
        uint16_t max_addr = 0x0000;
        size_t bytes_loaded = 0;
        std::string error;
    };

    static Result load(const std::string& source, std::vector<uint8_t>& memory) {
        if (memory.size() < 65536) {
            memory.resize(65536, 0x00);
        }

        Result res;
        std::string line;
        std::istringstream stream;

        // ファイルパスか直接のHEX文字列かを判定
        std::ifstream file(source);
        std::istream* input = nullptr;
        if (file.is_open()) {
            input = &file;
        } else {
            stream.str(source);
            input = &stream;
        }

        uint32_t line_no = 0;
        while (std::getline(*input, line)) {
            line_no++;
            // 改行や空白を除去
            while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) {
                line.pop_back();
            }
            if (line.empty()) continue;

            if (line[0] != ':') {
                continue; // コメントや空行をスキップ
            }

            if (line.length() < 11) {
                res.error = "Line " + std::to_string(line_no) + ": Too short for Intel HEX";
                return res;
            }

            auto hex_byte = [](const std::string& s, size_t pos) -> uint8_t {
                std::string b = s.substr(pos, 2);
                return static_cast<uint8_t>(std::stoul(b, nullptr, 16));
            };

            uint8_t byte_count = hex_byte(line, 1);
            uint16_t address = (static_cast<uint16_t>(hex_byte(line, 3)) << 8) | hex_byte(line, 5);
            uint8_t record_type = hex_byte(line, 7);

            if (line.length() < 11 + byte_count * 2) {
                res.error = "Line " + std::to_string(line_no) + ": Incomplete data field";
                return res;
            }

            if (record_type == 0x00) { // Data Record
                for (uint8_t i = 0; i < byte_count; ++i) {
                    uint8_t d = hex_byte(line, 9 + i * 2);
                    uint16_t target_addr = address + i;
                    memory[target_addr] = d;

                    if (target_addr < res.min_addr) res.min_addr = target_addr;
                    if (target_addr > res.max_addr) res.max_addr = target_addr;
                    res.bytes_loaded++;
                }
            } else if (record_type == 0x01) { // End of File
                break;
            }
        }

        res.success = (res.bytes_loaded > 0);
        return res;
    }
};
