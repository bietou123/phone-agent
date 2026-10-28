#!/data/data/com.termux/files/usr/bin/bash
PIDFILE="$HOME/.phone-agent/server.pid"
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
fi
pkill -f 'node .*server\.mjs' 2>/dev/null || true
termux-wake-unlock 2>/dev/null || true
echo "server stopped"
