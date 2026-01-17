#!/bin/bash
# Graceful restart - ensures new process is up before confirming
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "[restart] Starting graceful restart..."

# Get current PID
OLD_PID=""
if [ -f ".ode.pid" ]; then
    OLD_PID=$(cat .ode.pid)
fi

# Clear the log file for fresh detection
> ode.log

# Stop the old process
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[restart] Stopping old process (PID: $OLD_PID)..."

    # Kill the wrapper bash process and its children
    pkill -P "$OLD_PID" 2>/dev/null || true
    kill "$OLD_PID" 2>/dev/null || true

    # Wait for it to exit (max 10 seconds)
    for i in {1..20}; do
        if ! kill -0 "$OLD_PID" 2>/dev/null; then
            break
        fi
        sleep 0.5
    done

    # Force kill if still running
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[restart] Force killing old process..."
        kill -9 "$OLD_PID" 2>/dev/null || true
        pkill -9 -P "$OLD_PID" 2>/dev/null || true
    fi
fi

rm -f .ode.pid
rm -f .ode.pgid

# Start new process
echo "[restart] Starting new process..."
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

NEW_PID=$!
echo $NEW_PID > .ode.pid

# Wait for new process to be ready
echo "[restart] Waiting for new process to be ready..."
for i in {1..30}; do
    if grep -q "Ode is ready" ode.log 2>/dev/null; then
        echo "[restart] New process is ready (PID: $NEW_PID)"
        exit 0
    fi
    sleep 0.5
done

echo "[restart] Warning: New process may not be fully ready yet (PID: $NEW_PID)"
exit 0
