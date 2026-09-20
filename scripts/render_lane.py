#!/usr/bin/env python3
"""Blue Ocean render lane worker.

Runs inside GitHub Actions (ubuntu runner, Playwright Chromium).
Reads TARGET_URL from the environment, renders the page in a real
browser (which defeats Cloudflare's JS challenge), and writes:
  /tmp/dom.html   - the rendered DOM
  /tmp/meta.json  - status metadata for the cache branch
"""
import json
import os
import time

from playwright.sync_api import sync_playwright

try:  # optional hardening
    from playwright_stealth import Stealth
    _STEALTH = True
except Exception:  # noqa: BLE001
    _STEALTH = False

CF_MARKERS = ("Just a moment", "challenge-platform", "cf-chl", "__cf_chl")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def is_challenged(html: str) -> bool:
    return any(m in html for m in CF_MARKERS)


def main() -> None:
    url = os.environ.get("TARGET_URL", "").strip()
    if not url.lower().startswith("https://"):
        json.dump({"url": url, "status": "bad-url"}, open("/tmp/meta.json", "w"))
        raise SystemExit(0)

    meta = {"url": url, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    # Headed Chromium under Xvfb (virtual display) passes Cloudflare
    # Turnstile far more reliably than headless; RENDER_HEADED=0 forces off.
    headed = os.environ.get("RENDER_HEADED", "1") != "0"

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=not headed,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        ctx = browser.new_context(
            user_agent=UA, locale="en-US", viewport={"width": 1366, "height": 900}
        )
        page = ctx.new_page()
        if _STEALTH:
            try:
                Stealth().apply_stealth_sync(page)
            except Exception:  # noqa: BLE001
                pass
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
        except Exception as e:  # noqa: BLE001 - record and keep going
            meta["goto_error"] = str(e)[:200]

        def try_turnstile_click() -> None:
            """Click the Turnstile checkbox if the widget iframe is present."""
            try:
                for f in page.frames:
                    if "challenges.cloudflare.com" in (f.url or ""):
                        el = f.frame_element()
                        box = el.bounding_box()
                        if box:
                            page.mouse.click(
                                box["x"] + box["width"] / 2,
                                box["y"] + min(box["height"] / 2, 30),
                            )
                            return
            except Exception:  # noqa: BLE001
                pass

        # Cloudflare interstitial: poll up to ~90s; nudge the Turnstile
        # widget a few times in case it renders an interactive checkbox.
        for i in range(18):
            html = page.content()
            if not is_challenged(html):
                break
            if i in (4, 10, 16):
                try_turnstile_click()
            page.wait_for_timeout(5000)

        html = page.content()
        meta["challenged"] = is_challenged(html)
        meta["bytes"] = len(html)
        meta["status"] = "ok"
        with open("/tmp/dom.html", "w", encoding="utf-8") as f:
            f.write(html)
        browser.close()

    with open("/tmp/meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f)


if __name__ == "__main__":
    main()
