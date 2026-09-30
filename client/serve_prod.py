import http.server
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "serve_root")
PORT = 3199

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # no-cache so refreshes pick up new builds
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        # v6.9.120: SPA fallback for deep links (e.g. /Blue-Ocean/admin) —
        # serve index.html for extension-less paths so client routing runs.
        path = self.translate_path(self.path)
        if not os.path.isdir(path) and not os.path.isfile(path) and "." not in os.path.basename(path):
            self.path = "/Blue-Ocean/index.html"
        return super().send_head()

if __name__ == "__main__":
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving {ROOT} at http://127.0.0.1:{PORT}/Blue-Ocean/")
    server.serve_forever()
