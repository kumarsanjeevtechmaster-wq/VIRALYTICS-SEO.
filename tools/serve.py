#!/usr/bin/env python3
"""serve.py — static server for dist/.

  /                      dashboard, renders inline (live preview)
  /all                   the whole kit as a zip  → browser SAVES it
  /app                   index.html only          → browser SAVES it
  /get/<file>            any file in dist/ as a download
  /<file>?dl=1           same thing, explicit

Only thing it adds over python3 -m http.server is the Content-Disposition header, so
"open in browser" and "download the file" are two different links.

  Usage: python3 tools/serve.py [port]        (default 3000)
"""
import os, sys, functools, posixpath
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(HERE, 'dist')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
ALIASES = {'/all': '/viralytics-seo-dashboard.zip', '/zip': '/viralytics-seo-dashboard.zip',
           '/app': '/index.html', '/single': '/index.html', '/readme': '/README.md'}


class Handler(SimpleHTTPRequestHandler):
    def _download_target(self):
        """Return the filename to offer as a download, or None to serve inline."""
        p = self.path.split('?')[0]
        if p.startswith('/get/'):
            return p[len('/get/'):] or None
        if p in ALIASES:
            return ALIASES[p].lstrip('/')
        if 'dl=1' in self.path:
            return posixpath.basename(p)
        return None

    def send_head(self):
        target = self._download_target()
        if target:
            self._dl_name = target                      # remembered by end_headers()
            saved, self.path = self.path, '/' + target.lstrip('/')
            try:
                return SimpleHTTPRequestHandler.send_head(self)
            finally:
                self.path = saved
        self._dl_name = None
        return SimpleHTTPRequestHandler.send_head(self)

    def end_headers(self):
        if getattr(self, '_dl_name', None):
            # still inside the buffered header block → appends to the same response
            self.send_header('Content-Disposition',
                             'attachment; filename="%s"' % posixpath.basename(self._dl_name))
            self.send_header('Cache-Control', 'no-store')
            self._dl_name = None
        SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, fmt, *a):
        sys.stderr.write('   %s\n' % (fmt % a))


def main():
    os.makedirs(ROOT, exist_ok=True)
    with ThreadingHTTPServer(('0.0.0.0', PORT), functools.partial(Handler, directory=ROOT)) as srv:
        print('serving %s on 0.0.0.0:%d' % (ROOT, PORT), flush=True)
        srv.serve_forever()


if __name__ == '__main__':
    main()
