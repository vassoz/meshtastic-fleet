#!/usr/bin/env bash
# Serves MeshFleet locally. http://localhost counts as a secure context,
# which is all Web Bluetooth requires -- no HTTPS/certificate setup needed.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo "MeshFleet: http://localhost:${PORT}"
exec python3 -m http.server "$PORT"
