#!/usr/bin/env python3
"""Minimal static server for the idea-receipt folder.

Avoids os.getcwd() (blocked in the preview sandbox) by serving an explicit
directory derived from this file's absolute path.
"""
import functools
import http.server
import os
import socketserver
import sys

DIR = os.path.dirname(__file__) or "/Users/shaurya/Downloads/Claude Code/idea-receipt"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # never cache during development so edits show up on reload
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


HandlerWithDir = functools.partial(Handler, directory=DIR)
socketserver.TCPServer.allow_reuse_address = True

with socketserver.TCPServer(("", PORT), HandlerWithDir) as httpd:
    print(f"serving {DIR} on http://localhost:{PORT}")
    httpd.serve_forever()
