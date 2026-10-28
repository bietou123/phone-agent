#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null || true
mkdir -p "$HOME/.phone-agent"
PIDFILE="$HOME/.phone-agent/server.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "server already running: $(cat "$PIDFILE")"
  exit 0
fi
nohup node server.mjs >> "$HOME/.phone-agent/server.log" 2>&1 &
echo $! > "$PIDFILE"
sleep 1
echo "server started: $(cat "$PIDFILE")"
