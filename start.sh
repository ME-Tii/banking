#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "Starting Banking System..."

# Kill any leftover processes
pkill -f "node server.js" 2>/dev/null
pkill -f "ngrok http" 2>/dev/null
pkill -f "caffeinate" 2>/dev/null
sleep 1

# Prevent sleep
caffeinate -d -i -m -s -u &
CAFFPID=$!
echo "caffeinate PID: $CAFFPID"

# Start server
nohup node server.js > /tmp/banking-server.log 2>&1 &
SERVERPID=$!
echo "Server PID: $SERVERPID"

sleep 2

# Start ngrok
nohup ngrok http 8080 --log=stdout > /tmp/ngrok.log 2>&1 &
NGROKPID=$!
echo "ngrok PID: $NGROKPID"

sleep 4
RAW=$(grep -o 'url=https[^ ]*' /tmp/ngrok.log | head -1)
URL="${RAW#url=}"

# Restart server with PUBLIC_URL set
export PUBLIC_URL="$URL"
pkill -f "node server.js" 2>/dev/null
sleep 1
nohup node server.js > /tmp/banking-server.log 2>&1 &
SERVERPID=$!
echo "Server PID: $SERVERPID (PUBLIC_URL=$URL)"
sleep 2

echo ""
echo "============================================"
echo "  Banking System is running!"
echo "  Local:  http://localhost:8080"
echo "  Public: $URL"
echo "============================================"
echo ""
echo "Downloads are hosted on GitHub Releases:"
echo "  https://github.com/ME-Tii/banking/releases"
echo ""
echo "Stop all with:  pkill -f 'node server.js|ngrok http|caffeinate'"
echo "Or just:        ./stop.sh"
