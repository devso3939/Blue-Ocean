# Confirmation-link relay for http://localhost:3000 — GoTrue's DEFAULT Site URL.
#
# Until the project's Site URL is changed in the Supabase dashboard, every auth
# email that could not honor its requested redirect lands here. Instead of the
# browser's ERR_CONNECTION_REFUSED (nothing used to listen on 3000), this tiny
# server 302s the WHOLE URL — path, query, and the #access_token/… fragment —
# to the same address on the real app port (3199). The fragment survives the
# hop (Location headers may carry it), so consumeSignupLink/consumeRecoveryLink
# in the app see exactly the landing they expect and the user ends up
# signed in / on the set-password screen as designed.
#
# Run:  python serve_confirm_relay.py     (keep serve_prod.py running too)

import http.server

PORT = 3000
TARGET = "http://localhost:3199"

class Relay(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # GoTrue's default landings hit the site ROOT (http://localhost:3000#…).
        # Anything that isn't already the app path gets pointed at /Blue-Ocean/;
        # the browser re-attaches the original #fragment, so the grant survives.
        path = self.path if self.path.startswith("/Blue-Ocean") else "/Blue-Ocean/"
        self.send_response(302)
        self.send_header("Location", TARGET + path)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def log_message(self, fmt, *args):
        print("[relay]", fmt % args)

if __name__ == "__main__":
    print(f"Relaying http://localhost:{PORT}/ -> {TARGET}/ (fragments included)")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Relay).serve_forever()
