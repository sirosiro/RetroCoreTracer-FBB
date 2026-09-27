// @intent:responsibility エントリポイント。CLI 引数解析 (--test, --socket) とデーモン起動
#include <iostream>
#include <string>
#include "z80_daemon.hpp"

int main(int argc, char* argv[]) {
    std::string hex_file = "examples/fibonacci.hex";
    std::string socket_path = "";
    bool test_mode = false;
    size_t steps = 15;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--test") {
            test_mode = true;
            if (i + 1 < argc && argv[i+1][0] != '-') {
                hex_file = argv[++i];
            }
        } else if (arg == "--socket" && i + 1 < argc) {
            socket_path = argv[++i];
        } else if (arg == "--hex" && i + 1 < argc) {
            hex_file = argv[++i];
        } else if (arg == "--steps" && i + 1 < argc) {
            steps = std::stoul(argv[++i]);
        } else if (arg == "-h" || arg == "--help") {
            std::cout << "Usage: rct_z80_daemon [options]\n"
                      << "  --test [hex_file]   Run standalone verification steps and exit\n"
                      << "  --socket <path>     Listen on UNIX domain socket for F-BB / Web UI\n"
                      << "  --hex <file>        Load initial Intel HEX binary (default: examples/fibonacci.hex)\n"
                      << "  --steps <N>         Number of test steps (default: 15)\n"
                      << "  -h, --help          Show this help\n";
            return 0;
        }
    }

    Z80Daemon daemon;
    if (!daemon.init(hex_file)) {
        std::cerr << "[-] Error initializing Z80Daemon with " << hex_file << std::endl;
        return 1;
    }

    if (test_mode || socket_path.empty()) {
        daemon.run_standalone_test(steps);
        return 0;
    }

    daemon.run_socket_server(socket_path);
    return 0;
}
