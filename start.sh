#!/usr/bin/env bash
# Start the RT Archive Viewer at http://localhost:8642 and open it in the browser.
cd "$(dirname "$0")"
if [ ! -f data/videos.json ]; then
  echo "Building the video list first (takes ~10 minutes the first time)..."
  python3 scripts/build_data.py || exit 1
fi
exec python3 server.py "$@"
