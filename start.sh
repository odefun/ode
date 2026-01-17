#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Cleanup function to remove stale metadata
cleanup_stale_metadata() {
    if [ -f ".ode.pid" ]; then
        PID=$(cat .ode.pid)
        if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
            rm -f .ode.pid
        fi
    fi

    if [ -f ".ode.pgid" ]; then
        PGID=$(cat .ode.pgid)
        if [ -z "$PGID" ] || ! kill -0 -- -"$PGID" 2>/dev/null; then
            rm -f .ode.pgid
        fi
    fi
}

# Check if already running
if [ -f ".ode.pid" ]; then
    PID=$(cat .ode.pid)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo "Ode already running in this folder (PID: $PID)."
        echo "Use ./restart.sh to restart."
        exit 1
    fi
fi

# Remove stale metadata if previous process is gone
cleanup_stale_metadata

# Start with keepalive wrapper in its own process group
echo "Starting Ode..."
setsid bash -c "
cd '$SCRIPT_DIR'
export PATH=\"\$HOME/.bun/bin:\$PATH\"
# Save our process group ID for cleanup
echo \$\$ > .ode.pgid
while true; do
    echo '[keepalive] Starting bun process...'
    bun run src/index.ts
    EXIT_CODE=\$?
    echo \"[keepalive] Process exited with code \$EXIT_CODE, restarting in 2s...\"
    sleep 2
done
" >> ode.log 2>&1 &

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
