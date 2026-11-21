#!/usr/bin/env python3
"""Local server for the RT / AH / Let's Play archive viewer.

Serves the site on http://localhost:8642 and keeps a copy of your watch progress in
data/progress.json (in addition to the browser's localStorage), so progress survives
clearing browser data or switching browsers.

  python3 server.py            # start and open the browser
  python3 server.py --no-open  # start without opening a browser
  PORT=9000 python3 server.py  # different port (note: localStorage is per-port)
"""

import json
import os
import sys
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROGRESS = ROOT / "data" / "progress.json"
BACKUPS = ROOT / "data" / "progress-backups"   # one snapshot per hour of use, last 72 kept
KEEP_BACKUPS = 72
PORT = int(os.environ.get("PORT", "8642"))
MAX_BODY = 10 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" not in (self.path or ""):
            return
        super().log_message(fmt, *args)

    def _json(self, code: int, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/progress":
            body = PROGRESS.read_bytes() if PROGRESS.exists() else b"{}"
            return self._json(200, body)
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/progress":
            return self._json(404, b'{"error":"not found"}')
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(400, b'{"error":"bad length"}')
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw)
            assert isinstance(data, dict)
        except Exception:
            return self._json(400, b'{"error":"bad json"}')
        # Never let an older snapshot (e.g. from a stale tab) overwrite a newer one.
        if PROGRESS.exists():
            try:
                if json.loads(PROGRESS.read_bytes()).get("at", 0) > data.get("at", 0):
                    return self._json(409, b'{"error":"stale"}')
            except Exception:
                pass
        PROGRESS.parent.mkdir(exist_ok=True)
        snapshot_previous()
        tmp = PROGRESS.with_suffix(".tmp")
        tmp.write_bytes(raw)
        tmp.replace(PROGRESS)
        return self._json(200, b'{"ok":true}')

    do_PUT = do_POST


def snapshot_previous():
    """Before overwriting progress.json, keep the old copy if this hour has no snapshot yet."""
    if not PROGRESS.exists():
        return
    try:
        BACKUPS.mkdir(exist_ok=True)
        snap = BACKUPS / time.strftime("progress-%Y%m%d-%H.json")
        if not snap.exists():
            snap.write_bytes(PROGRESS.read_bytes())
            for old in sorted(BACKUPS.glob("progress-*.json"))[:-KEEP_BACKUPS]:
                old.unlink()
    except OSError as exc:
        print(f"progress backup failed: {exc}", file=sys.stderr)


def main():
    if not (ROOT / "data" / "videos.json").exists():
        print("data/videos.json not found - run: python3 scripts/build_data.py", file=sys.stderr)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}/"
    print(f"Serving {url}  (Ctrl+C to stop)", flush=True)
    if "--no-open" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
