#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "Starting Banking System..."

# Kill any leftover processes
pkill -f "node server.js" 2>/dev/null
pkill -f "node.*8081" 2>/dev/null
pkill -f "ngrok http" 2>/dev/null
pkill -f "caffeinate" 2>/dev/null
sleep 1

# Prevent sleep
caffeinate -d -i -m -s -u &
CAFFPID=$!
echo "caffeinate PID: $CAFFPID"

# Start download server (bypasses ngrok 25 MB limit)
nohup node -e "
const http = require('http'), fs = require('fs'), path = require('path')
const DIR = '$DIR'
const MIME = { '.dmg':'application/x-apple-diskimage', '.exe':'application/x-msdownload', '.AppImage':'application/octet-stream', '.deb':'application/vnd.debian.binary-package', '.blockmap':'application/json' }
http.createServer((req, res) => {
  const file = path.join(DIR, decodeURI(req.url).split('?')[0])
  if (!file.startsWith(DIR + '/release')) return res.writeHead(403).end()
  if (!fs.existsSync(file)) return res.writeHead(404).end()
  const stat = fs.statSync(file)
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': 'attachment; filename=\"' + path.basename(file) + '\"',
    'Accept-Ranges': 'bytes',
  })
  fs.createReadStream(file).pipe(res)
}).listen(8081, () => console.log('Download server on :8081'))
" > /tmp/download-server.log 2>&1 &
sleep 1

# Start Cloudflare tunnel for downloads (no 25 MB limit, no port forwarding needed)
nohup cloudflared tunnel --url http://localhost:8081 > /tmp/cloudflared.log 2>&1 &
CLOUDFLAREDPID=$!
echo "cloudflared PID: $CLOUDFLAREDPID"

# Start server (without downloadHost env, server.js falls back to PKG.downloadHost)
nohup node server.js > /tmp/banking-server.log 2>&1 &
SERVERPID=$!
echo "Server PID: $SERVERPID"

# Wait for server to be ready
sleep 2

# Start ngrok
nohup ngrok http 8080 --log=stdout > /tmp/ngrok.log 2>&1 &
NGROKPID=$!
echo "ngrok PID: $NGROKPID"

sleep 4
RAW=$(grep -o 'url=https[^ ]*' /tmp/ngrok.log | head -1)
URL="${RAW#url=}"

# Wait for cloudflare tunnel URL
sleep 3
CF_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log | head -1)

# Set public URL and download host
export PUBLIC_URL="$URL"
export DOWNLOAD_HOST="$CF_URL"

# Restart server with PUBLIC_URL and DOWNLOAD_HOST set
pkill -f "node server.js" 2>/dev/null
sleep 1
nohup node server.js > /tmp/banking-server.log 2>&1 &
SERVERPID=$!
echo "Server PID: $SERVERPID (PUBLIC_URL=$URL)"
echo "Download host: $CF_URL"
sleep 2

echo ""
echo "============================================"
echo "  Banking System is running!"
echo "  Local:  http://localhost:8080"
echo "  Public: $URL"
echo "  Downloads: ${CF_URL:-http://localhost:8081}"
echo "============================================"
echo ""
echo "Stop all with:  pkill -f 'node server.js|node.*8081|ngrok http|cloudflared|caffeinate'"
echo "Or just:        ./stop.sh"
