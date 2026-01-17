#!/bin/bash
cd "$(dirname "$0")"

if [ ! -f ".ode.pid" ]; then
    echo "Ode is not running (no PID file)"
    exit 1
fi

PID=$(cat .ode.pid)

if kill -0 "$PID" 2>/dev/null; then
    echo "Ode is running (PID: $PID)"
    echo ""
    echo "Recent logs:"
    tail -20 ode.log 2>/dev/null || echo "(no logs)"
    exit 0
else
    echo "Ode is not running (stale PID)"
    rm -f .ode.pid
    exit 1
fi
