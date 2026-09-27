#!/bin/bash
# RetroCoreTracer-FBB: Scenario Launcher Script
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

echo "=================================================="
echo "  RetroCoreTracer Z80 Studio Scenario Runner"
echo "=================================================="

# Check if daemon is compiled
if [ -f "$PLUGIN_DIR/bin/rct_z80_daemon" ]; then
    echo "[Scenario] Starting RCT Z80 Daemon in background..."
    "$PLUGIN_DIR/bin/rct_z80_daemon" --hex "$PLUGIN_DIR/examples/fibonacci.hex" --socket /tmp/rct_z80.sock > /tmp/rct_z80_daemon.log 2>&1 &
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
