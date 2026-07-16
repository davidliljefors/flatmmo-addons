#!/usr/bin/env python3
"""
CORS dev server for Flat Mod Loader.

`python -m http.server` does NOT send CORS headers, so the loader's page-context
fetch() to http://localhost:... gets blocked. This server adds `Access-Control-
Allow-Origin: *` + `Cache-Control: no-store`, so you can use a localhost source
(e.g. http://localhost:8611/) and see edits on reload without pushing to GitHub.

Usage (from the repo root):
    python serve.py           # serves this folder on http://127.0.0.1:8611/
    python serve.py 9000      # custom port
"""
import functools
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8611
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


handler = functools.partial(Handler, directory=ROOT)
with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
    print(f"CORS serving {ROOT} on http://127.0.0.1:{PORT}/ (Ctrl+C to stop)")
    httpd.serve_forever()
