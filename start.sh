#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Cleanup function to kill old processes by process group
cleanup_old_processes() {
    echo "Cleaning up old processes..."

    # Kill by saved process group ID (most reliable)
    if [ -f ".ode.pgid" ]; then
        PGID=$(cat .ode.pgid)
        if [ -n "$PGID" ]; then
            echo "Killing process group $PGID..."
            kill -- -"$PGID" 2>/dev/null || true
        fi
        rm -f .ode.pgid
    fi

    # Fallback: kill by pattern (for orphaned processes)
    pkill -f "bun run src/index.ts" 2>/dev/null || true
    pkill -f "bun run /root/ode/src/mcp/server.ts" 2>/dev/null || true
    # Kill OpenCode servers spawned by ode (uses port=0 for dynamic assignment)
    pkill -f "opencode serve.*port=0" 2>/dev/null || true
    sleep 1
}

# Check if already running
if [ -f ".ode.pid" ]; then
    PID=$(cat .ode.pid)
    if kill -0 "$PID" 2>/dev/null; then
        echo "Stopping existing Ode (PID: $PID)..."
        kill "$PID" 2>/dev/null || true
        sleep 1
    fi
    rm -f .ode.pid
fi

# Always cleanup stale processes
cleanup_old_processes

# Start with keepalive wrapper in its own process group
echo "Starting Ode..."
setsid bash -c "
cd '$SCRIPT_DIR'
# Save our process group ID for cleanup
echo \$\$ > .ode.pgid
while true; do
    echo '[keepalive] Starting bun process...'
    bun run src/index.ts
    EXIT_CODE=\$?
    echo \"[keepalive] Process exited with code \$EXIT_CODE, restarting in 2s...\"
    sleep 2
done
" > ode.log 2>&1 &

PID=$!
echo $PID > .ode.pid

# Wait for ready
echo "Waiting for Ode to be ready..."
for i in {1..30}; do
    if grep -q "Ode is ready" ode.log 2>/dev/null; then
        echo "Ode started (PID: $PID)"
        echo "Logs: tail -f ode.log"
        exit 0
    fi
    sleep 0.5
done

echo "Ode started (PID: $PID) - may still be initializing"
echo "Logs: tail -f ode.log"
