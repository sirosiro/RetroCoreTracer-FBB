#!/bin/bash
# RetroCoreTracer-FBB: Scenario Launcher Script
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

echo "=================================================="
echo "  RetroCoreTracer Z80 Studio Scenario Runner"
echo "=================================================="

# Parse HEX file from arguments or environment variable
HEX_ARG=""
for arg in "$@"; do
    if [[ "$arg" == *.hex ]]; then
        HEX_ARG="$arg"
        break
    fi
done

while [ $# -gt 0 ]; do
    case "$1" in
        --hex)
            HEX_ARG="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

if [ -n "$HEX_ARG" ]; then
    HEX_PATH="$HEX_ARG"
else
    HEX_PATH="${HEX_FILE:-$PLUGIN_DIR/examples/fibonacci.hex}"
fi

# Resolve relative path if needed
if [ -n "$HEX_PATH" ] && [[ "$HEX_PATH" != /* ]]; then
    if [ -f "$PWD/$HEX_PATH" ]; then
        HEX_PATH="$PWD/$HEX_PATH"
    elif [ -f "$PLUGIN_DIR/$HEX_PATH" ]; then
        HEX_PATH="$PLUGIN_DIR/$HEX_PATH"
    elif [ -f "$SCRIPT_DIR/$HEX_PATH" ]; then
        HEX_PATH="$SCRIPT_DIR/$HEX_PATH"
    fi
fi

echo "[Scenario] Active HEX: $HEX_PATH"

# Generate structured program JSON for Web Dashboard Code View
if [ -f "$PLUGIN_DIR/scripts/hex_to_program.py" ]; then
    python3 "$PLUGIN_DIR/scripts/hex_to_program.py" "$HEX_PATH" "/tmp/rct_active_program.json" 2>/dev/null || true
fi

# Check if daemon is compiled
if [ -f "$PLUGIN_DIR/bin/rct_z80_daemon" ]; then
    echo "[Scenario] Starting RCT Z80 Daemon in background with HEX: $HEX_PATH"
    "$PLUGIN_DIR/bin/rct_z80_daemon" --hex "$HEX_PATH" --socket /tmp/rct_z80.sock > /tmp/rct_z80_daemon.log 2>&1 &
    DAEMON_PID=$!
    trap "kill $DAEMON_PID 2>/dev/null || true" EXIT INT TERM
fi

if [ "$FBB_ACTIVE" = "1" ]; then
    cd "$SCRIPT_DIR"
    ./test_bin
else
    # Direct execution or standalone lab
    "$SCRIPT_DIR/../../FPGA-BoardlessBench/scenario_runner.sh" "$SCRIPT_DIR" "$@"
fi
