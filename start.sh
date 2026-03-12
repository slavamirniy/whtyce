#!/bin/bash
# tmate-mobile launcher
# Usage: ./start.sh [port] [secret]
#   port   - port to listen on (default: 8075)
#   secret - session secret (default: auto-generated)

PORT="${1:-8075}"
SECRET="${2:-}"

export PORT
if [ -n "$SECRET" ]; then
  export SECRET
fi

echo "Starting tmate-mobile on port $PORT..."
exec npx ts-node "$(dirname "$0")/src/server.ts"
