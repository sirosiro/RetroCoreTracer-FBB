#!/bin/bash
# RetroCoreTracer-FBB: Scenario Launcher Script
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

echo "=================================================="
echo "  RetroCoreTracer Z80 Studio Scenario Runner"
echo "=================================================="

# Parse ASM or HEX file from arguments or environment variable
ORIG_ARGS=("$@")
INPUT_ARG=""
for arg in "$@"; do
    if [[ "$arg" == *.asm ]] || [[ "$arg" == *.hex ]]; then
        INPUT_ARG="$arg"
        break
    fi
done

while [ $# -gt 0 ]; do
    case "$1" in
        --asm)
            INPUT_ARG="$2"
            shift 2
            ;;
        --hex)
            INPUT_ARG="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

if [ -n "$INPUT_ARG" ]; then
    SRC_PATH="$INPUT_ARG"
elif [ -n "$HEX_FILE" ]; then
    SRC_PATH="$HEX_FILE"
elif [ -f "$PLUGIN_DIR/examples/fibonacci.asm" ]; then
    SRC_PATH="$PLUGIN_DIR/examples/fibonacci.asm"
else
    SRC_PATH="$PLUGIN_DIR/examples/fibonacci.hex"
fi

# Resolve relative path if needed
if [ -n "$SRC_PATH" ] && [[ "$SRC_PATH" != /* ]]; then
    if [ -f "$PWD/$SRC_PATH" ]; then
        SRC_PATH="$PWD/$SRC_PATH"
    elif [ -f "$PLUGIN_DIR/$SRC_PATH" ]; then
        SRC_PATH="$PLUGIN_DIR/$SRC_PATH"
    elif [ -f "$SCRIPT_DIR/$SRC_PATH" ]; then
        SRC_PATH="$SCRIPT_DIR/$SRC_PATH"
    fi
fi

if [[ "$SRC_PATH" == *.asm ]]; then
    echo "[Scenario] Active ASM: $SRC_PATH"
    HEX_PATH="/tmp/rct_active.hex"

    # Plugin-autonomous JIT installer: Auto-install z80asm if neither z80asm nor pasmo is available
    if ! command -v z80asm >/dev/null 2>&1 && ! command -v pasmo >/dev/null 2>&1; then
        echo "[Scenario] Neither 'z80asm' nor 'pasmo' found in PATH."
        echo "[Scenario] Performing plugin-autonomous JIT installation of z80asm..."
        if [ "$(id -u)" = "0" ] && command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq z80asm >/dev/null 2>&1 || true
        elif command -v sudo >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
            sudo apt-get update -qq >/dev/null 2>&1 && sudo apt-get install -y -qq z80asm >/dev/null 2>&1 || true
        fi
        if command -v z80asm >/dev/null 2>&1; then
            echo "[Scenario] ✨ JIT installation succeeded: z80asm is now ready."
        else
            echo "[Scenario Warning] JIT installation failed or not supported in this environment."
        fi
    fi

    if [ -f "$PLUGIN_DIR/scripts/asm_to_program.py" ]; then
        if ! python3 "$PLUGIN_DIR/scripts/asm_to_program.py" "$SRC_PATH" "$HEX_PATH" "/tmp/rct_active_program.json"; then
            echo "[Scenario Error] Failed to assemble $SRC_PATH"
            exit 1
        fi
    else
        echo "[Scenario Error] scripts/asm_to_program.py not found!"
        exit 1
    fi
else
    HEX_PATH="$SRC_PATH"
    echo "[Scenario] Active HEX: $HEX_PATH"
    if [ -f "$PLUGIN_DIR/scripts/hex_to_program.py" ]; then
        python3 "$PLUGIN_DIR/scripts/hex_to_program.py" "$HEX_PATH" "/tmp/rct_active_program.json" 2>/dev/null || true
    fi
fi

# Check if daemon is compiled; auto-build via CMake if missing
if [ ! -f "$PLUGIN_DIR/bin/rct_z80_daemon" ]; then
    echo "[Scenario] Binary rct_z80_daemon not found. Auto-building via CMake..."
    cmake -B "$PLUGIN_DIR/build" -S "$PLUGIN_DIR" >/dev/null 2>&1
    cmake --build "$PLUGIN_DIR/build" >/dev/null 2>&1
fi

if [ -f "$PLUGIN_DIR/bin/rct_z80_daemon" ]; then
    echo "[Scenario] Starting RCT Z80 Daemon in background with HEX: $HEX_PATH"
    "$PLUGIN_DIR/bin/rct_z80_daemon" --hex "$HEX_PATH" --socket /tmp/rct_z80.sock > /tmp/rct_z80_daemon.log 2>&1 &
    DAEMON_PID=$!
    trap "kill $DAEMON_PID 2>/dev/null || true" EXIT INT TERM
else
    echo "[Scenario Warning] Failed to start rct_z80_daemon (binary not found)."
fi

if [ "$FBB_ACTIVE" = "1" ]; then
    cd "$SCRIPT_DIR"
    ./test_bin
else
    # Direct execution or standalone lab
    RUNNER="${FBB_ROOT:-$SCRIPT_DIR/../../FPGA-BoardlessBench}/tests/scenario_runner.sh"
    if [ -f "$RUNNER" ]; then
        "$RUNNER" "$SCRIPT_DIR" "${ORIG_ARGS[@]}"
    else
        echo "[Scenario Error] F-BB scenario_runner.sh not found at: $RUNNER"
        exit 1
    fi
fi
