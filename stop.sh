#!/bin/bash
cd "$(dirname "$0")"

if [ ! -f ".ode.pid" ]; then
    echo "Ode is not running (no PID file)"
    exit 0
fi

PID=$(cat .ode.pid)

if ! kill -0 "$PID" 2>/dev/null; then
    echo "Ode is not running (stale PID)"
    rm -f .ode.pid
    exit 0
fi

echo "Stopping Ode (PID: $PID)..."
kill "$PID"

# Wait for process to exit
for i in {1..10}; do
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "Ode stopped"
        rm -f .ode.pid
        exit 0
    fi
    sleep 1
done

# Force kill if still running
echo "Force killing..."
kill -9 "$PID" 2>/dev/null
rm -f .ode.pid

# Clean up any orphaned opencode processes
pkill -f "opencode serve" 2>/dev/null || true

echo "Ode stopped"
