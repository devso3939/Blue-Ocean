"""Blue Ocean render worker - Flask API around Camoufox/Chromium.

POST /render  {url, token}  ->  {status, engine, challenged, bytes, html}
GET  /health               ->  {ok: true}
"""
import json
import os
import threading

from flask import Flask, jsonify, request

_lock = threading.Lock()  # one browser at a time inside the container

try:
    from camoufox.sync_api import Camoufox
    HAS_CAMOUFOX = True
except Exception:  # noqa: BLE001
    HAS_CAMOUFOX = False

from playwright.sync_api import sync_playwright

try:
    from playwright_stealth import Stealth
    HAS_STEALTH = True
except Exception:  # noqa: BLE001
    HAS_STEALTH = False

CF_MARKERS = ("Just a moment", "challenge-platform", "cf-chl", "__cf_chl")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
TOKEN = os.environ.get("BO_RENDER_TOKEN", "")

app = Flask(__name__)


def is_challenged(html: str) -> bool:
    return any(m in html for m in CF_MARKERS)


def _try_turnstile(page) -> None:
    try:
        for f in page.frames:
            if "challenges.cloudflare.com" in (f.url or ""):
                el = f.frame_element()
                box = el.bounding_box()
                if box:
                    page.mouse.click(box["x"] + box["width"] / 2,
                                     box["y"] + min(box["height"] / 2, 30))
                    return
    except Exception:  # noqa: BLE001
        pass


def _poll(page, cycles: int = 18) -> None:
    for i in range(cycles):
        if not is_challenged(page.content()):
            return
        if i in (4, 10, 16):
            _try_turnstile(page)
        page.wait_for_timeout(5000)


def render_camoufox(url: str, meta: dict) -> None:
    with Camoufox(headless=True, humanize=True) as browser:
        page = browser.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
        except Exception as e:  # noqa: BLE001
            meta["goto_error"] = str(e)[:200]
        _poll(page)
        html = page.content()
        meta["engine"] = "camoufox"
        meta["challenged"] = is_challenged(html)
        meta["bytes"] = len(html)
        meta["html"] = html


def render_chromium(url: str, meta: dict) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox", "--disable-dev-shm-usage"])
        ctx = browser.new_context(user_agent=UA, locale="en-US",
                                  viewport={"width": 1366, "height": 900})
        page = ctx.new_page()
        if HAS_STEALTH:
            try:
                Stealth().apply_stealth_sync(page)
            except Exception:  # noqa: BLE001
                pass
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
        except Exception as e:  # noqa: BLE001
            meta["goto_error"] = str(e)[:200]
        _poll(page)
        html = page.content()
        meta["engine"] = "chromium"
        meta["challenged"] = is_challenged(html)
        meta["bytes"] = len(html)
        meta["html"] = html
        browser.close()


@app.get("/health")
def health():
    return jsonify(ok=True, camoufox=HAS_CAMOUFOX)


@app.post("/render")
def render():
    data = request.get_json(silent=True) or {}
    if TOKEN and data.get("token") != TOKEN:
        return jsonify(error="unauthorized"), 401
    url = (data.get("url") or "").strip()
    if not url.lower().startswith("https://"):
        return jsonify(error="bad-url"), 400

    meta = {"url": url, "status": "ok"}
    with _lock:
        if HAS_CAMOUFOX:
            try:
                render_camoufox(url, meta)
            except Exception as e:  # noqa: BLE001
                meta["camoufox_error"] = str(e)[:200]
        if meta.get("challenged", True) or not meta.get("html"):
            try:
                render_chromium(url, meta)
            except Exception as e:  # noqa: BLE001
                meta["chromium_error"] = str(e)[:200]
    return jsonify(**meta), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
