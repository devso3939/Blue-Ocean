"""Crawl queue tests (run from backend/).

Drives the queue offline through injected fetch/render functions — no network,
no browser. Covers depth modes, the render-lane fallback, domain gating,
robots.txt, budgets, and the /api/crawl + /api/jobs entry points.
"""
from __future__ import annotations

from app.services import crawler
from app.services.crawler import (
    Crawler,
    extract_contacts,
    harvest_anchors,
    infer_country,
    is_challenge_page,
    is_spa_shell,
    normalize_url,
    normalize_mode,
    registrable_domain,
    same_registrable_domain,
    score_links,
    to_e164,
)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def page(title: str = "T", body: str = "", links: list[str] | None = None,
         jsonld: str | None = None) -> str:
    """A minimal HTML document shaped like a business website."""
    anchors = "".join(f'<a href="{u}">Contact us</a>' for u in (links or []))
    ld = f'<script type="application/ld+json">{jsonld}</script>' if jsonld else ""
    return (
        f"<html><head><title>{title}</title>{ld}</head>"
        f"<body><nav>{anchors}</nav><div>{body}</div></body></html>"
    )


CHALLENGE = '<html><head><title>Just a moment…</title></head><body>challenge-platform __cf_chl</body></html>'
# >= 200 chars, like a real SPA shell (a long <head> full of bundle tags);
# is_spa_shell refuses to classify anything shorter, exactly as the client does.
SPA = (
    '<html><head><meta charset="utf-8">'
    + '<script src="/static/js/main.8f3a1b2c.js"></script>' * 3
    + '<link rel="stylesheet" href="/static/css/main.css">'
    + '</head><body><noscript>You need to enable JavaScript to run this app.</noscript>'
    + '<div id="root"></div></body></html>'
)


class FakeSite:
    """url -> html. Fetch returns the page; render returns `rendered` for the
    challenge/SPA pages. Every call is logged so tests can assert budgets."""

    def __init__(self, pages: dict[str, str], rendered: dict[str, str] | None = None):
        self.pages = pages
        self.rendered = rendered or {}
        self.fetch_log: list[str] = []
        self.render_log: list[str] = []

    def fetch(self, url: str) -> str | None:
        self.fetch_log.append(url)
        if url.endswith("/robots.txt"):
            return self.pages.get("robots.txt")
        return self.pages.get(url)

    def render(self, url: str) -> str | None:
        self.render_log.append(url)
        return self.rendered.get(url)


def page_fetches(site: FakeSite) -> list[str]:
    """Fetch log minus robots.txt probes (those are host setup, not crawl)."""
    return [u for u in site.fetch_log if not u.endswith("/robots.txt")]


# ---------------------------------------------------------------------------
# 1. URL / domain helpers
# ---------------------------------------------------------------------------
assert normalize_url("https://www.cafe.ge/about/") == "https://cafe.ge/about"
assert normalize_url("https://cafe.ge/") == "https://cafe.ge/"
assert normalize_url("https://cafe.ge/page?a=1#frag") == "https://cafe.ge/page?a=1"

# Public-Suffix-List correctness — the naive "last two labels" rule fails here
assert registrable_domain("https://shop.example.co.uk/") == "example.co.uk"
assert registrable_domain("https://a.co.uk") != registrable_domain("https://b.co.uk")
assert same_registrable_domain("https://shop.cafe.ge/", "https://cafe.ge/contact")
assert not same_registrable_domain("https://cafe.ge/", "https://other.ge/")
assert not same_registrable_domain("https://cafe.ge/", "https://not-cafe.ge/")

assert infer_country("https://cafe.ge/contact") == "GE"
assert infer_country("https://cafe.com/") is None  # .com carries no country

# ---------------------------------------------------------------------------
# 2. page-shape gates (verbatim client semantics)
# ---------------------------------------------------------------------------
assert is_challenge_page(CHALLENGE)
assert not is_challenge_page(page())
assert is_spa_shell(SPA)
# every canonical mount point must be recognised, not just the first
# (>= 200 chars, padded with bundle tags like a real shell)
for _marker in ('id="root"', 'id="__next"', 'data-reactroot', '__NUXT__'):
    _doc = ('<html><head>' + '<script src="/b.js"></script>' * 6 +
            '</head><body><div ' + _marker + '></div></body></html>')
    assert len(_doc) >= 200, len(_doc)
    assert is_spa_shell(_doc), _marker
assert not is_spa_shell(page(body="x" * 400))  # real content → not a shell
assert not is_spa_shell('')                    # empty → not a shell

# ---------------------------------------------------------------------------
# 3. anchor harvesting — no regex harvesting
# ---------------------------------------------------------------------------
# attribute order: href last, unquoted href, nested markup
assert harvest_anchors('<a class="b" data-x="1" href="/contact">Contact</a>')[0][0] == "/contact"
assert harvest_anchors("<a href=/about>About</a>")[0][0] == "/about"
assert harvest_anchors('<a href="/c"><b>Contact</b> us</a>')[0][1] == "Contact us"
assert harvest_anchors("<a>No href</a>") == []   # href-less <a> is not a link

# ---------------------------------------------------------------------------
# 4. link scoring
# ---------------------------------------------------------------------------
base = "https://cafe.ge/"
scored = score_links(
    '<a href="/contact-us">Contact us</a>'
    '<a href="/menu.pdf">Menu</a>'
    '<a href="/other-site">Other</a>'          # external → dropped
    '<a href="https://facebook.com/x">fb</a>'  # platform → dropped
    '<a href="/about">About us</a>'
    '<a href="/">Home</a>',                    # homepage → dropped
    base)
assert scored[0] == "https://cafe.ge/contact-us", scored   # strong contact term wins
assert all("other-site" not in u for u in scored)
assert all("facebook.com" not in u for u in scored)
assert all("menu.pdf" not in u for u in scored)
assert all(u != "https://cafe.ge/" for u in scored)

# ---------------------------------------------------------------------------
# 5. contact extraction
# ---------------------------------------------------------------------------
c = extract_contacts(
    page(body="Call +995 322 19 66 69 or write info@example-cafe.ge"),
    "https://cafe.ge/", country="GE")
assert c["emails"] == ["info@example-cafe.ge"], c
assert c["phones"] == ["+995322196669"], c          # E.164, region-aware

c2 = extract_contacts(page(body="Email finance-software@2x.png and admin@example.com"), base)
assert "admin@example.com" not in c2["emails"]       # junk domain rejected
assert not any(".png" in e for e in c2["emails"])    # asset filename rejected

c3 = extract_contacts(page(body="Reach us at <b>hello@cafe.ge</b>"), base)
assert c3["emails"] == ["hello@cafe.ge"], c3

c4 = extract_contacts(
    page(jsonld='{"@type":"LocalBusiness","telephone":"+995 322 19 66 69","email":"info@cafe.ge"}'),
    base, country="GE")
assert "info@cafe.ge" in c4["emails"]
assert "+995322196669" in c4["phones"]

c5 = extract_contacts(page(jsonld='{"@graph":[{"@type":"Organization","sameAs":["https://www.instagram.com/cafepage"]}]}'), base)
assert c5["socials"].get("instagram") == "https://www.instagram.com/cafepage", c5

c6 = extract_contacts(page(body='<a href="mailto:sales@cafe.ge">mail</a><a href="tel:+995322196669">call</a>'), base, country="GE")
assert c6["emails"] == ["sales@cafe.ge"]
assert c6["phones"] == ["+995322196669"]

assert to_e164("0322 19 66 69", "GE") == "+995322196669"
assert to_e164("not a number") == ""
assert to_e164("") == ""

# ---------------------------------------------------------------------------
# 6. the crawl queue — depth modes
# ---------------------------------------------------------------------------
SITE = {
    "https://cafe.ge/": page(
        links=["/contact-us", "/about", "/menu.pdf", "https://other.ge/", "https://facebook.com/x"]),
    "https://cafe.ge/contact-us": page(body="Email info@cafe.ge", links=["/team"]),
    "https://cafe.ge/about": page(body="About us, established 1998"),
    "https://cafe.ge/team": page(body="Our staff, call +995 322 19 66 69"),
    "https://other.ge/": page(body="other@example.com"),
}

# homepage mode → exactly one page, nothing enqueued
site = FakeSite(dict(SITE))
r = Crawler(fetch=site.fetch, render=site.render).crawl("https://cafe.ge/", "homepage")
assert r["ok"] and r["mode"] == "homepage"
assert len(r["pages"]) == 1, r["pages"]
assert r["stats"]["pages_fetched"] == 1
assert len(page_fetches(site)) == 1, page_fetches(site)

# key_pages mode → homepage + contact links (depth 1), NOT /team (depth 2)
site = FakeSite(dict(SITE))
r = Crawler(fetch=site.fetch, render=site.render).crawl("https://cafe.ge/", "key_pages")
urls = [p["url"] for p in r["pages"]]
assert "https://cafe.ge/" in urls
assert "https://cafe.ge/contact-us" in urls, urls
assert "https://cafe.ge/team" not in urls, urls
assert "https://cafe.ge/menu.pdf" not in urls, urls

# deep mode → reaches depth 2 (/team off /contact-us)
site = FakeSite(dict(SITE))
r = Crawler(fetch=site.fetch, render=site.render).crawl("https://cafe.ge/", "deep")
urls = [p["url"] for p in r["pages"]]
assert "https://cafe.ge/team" in urls, urls
assert all(u.startswith("https://cafe.ge/") for u in urls), urls  # never leaves the site
assert r["stats"]["pages_fetched"] <= r["budget"]["max_pages"]

# the crawl NEVER left the business's own registrable domain
assert all("other.ge" not in u for u in urls)
assert all("facebook.com" not in u for u in urls)

# ---------------------------------------------------------------------------
# 7. render lane as the browser backend
# ---------------------------------------------------------------------------
# plain fetch hits a CF challenge → escalate to the render lane
site = FakeSite(
    {"https://cafe.ge/": CHALLENGE, "https://cafe.ge/contact-us": page(body="Email info@cafe.ge")},
    rendered={"https://cafe.ge/": page(links=["/contact-us"])})
r = Crawler(fetch=site.fetch, render=site.render).crawl("https://cafe.ge/", "key_pages")
assert site.render_log == ["https://cafe.ge/"], site.render_log
assert r["pages"][0]["source"] == "render", r["pages"][0]
assert r["stats"]["pages_rendered"] == 1
assert "info@cafe.ge" in r["contacts"]["emails"]  # render lane unlocked the site

# homepage mode grants zero renders → the challenge page is simply dropped
site = FakeSite({"https://cafe.ge/": CHALLENGE}, rendered={"https://cafe.ge/": page()})
r = Crawler(fetch=site.fetch, render=site.render).crawl("https://cafe.ge/", "homepage")
assert site.render_log == [], site.render_log        # never called
assert r["pages"] == []
assert r["stats"]["pages_rendered"] == 0

# an SPA shell (JS-only body) also escalates
site = FakeSite(
    {"https://cafe.ge/": SPA, "https://cafe.ge/contact-us": page(body="Email info@cafe.ge")},
    rendered={"https://cafe.ge/": page(links=["/contact-us"])})
r = Crawler(fetch=site.fetch, render=site.render).crawl("https://cafe.ge/", "key_pages")
assert r["pages"][0]["source"] == "render"

# render budget is respected even in deep mode
site = FakeSite(
    {**SITE, "https://cafe.ge/": CHALLENGE, "https://cafe.ge/about": CHALLENGE},
    rendered={"https://cafe.ge/": page(links=["/contact-us", "/about"]),
              "https://cafe.ge/about": page()})
Crawler(fetch=site.fetch, render=site.render).crawl("https://cafe.ge/", "deep")
# only the CHALLENGED pages escalate to the browser lane — plain HTTP pages
# must never burn a render (the lane is one browser behind one lock)
assert len(site.render_log) == 2, site.render_log
assert set(site.render_log) == {"https://cafe.ge/", "https://cafe.ge/about"}

# ---------------------------------------------------------------------------
# 8. robots.txt is honoured
# ---------------------------------------------------------------------------
site = FakeSite({**SITE, "robots.txt": "User-agent: *\nDisallow: /about\n"})
r = Crawler(fetch=site.fetch, render=site.render).crawl("https://cafe.ge/", "deep")
fetched = page_fetches(site)
assert "https://cafe.ge/about" not in fetched, fetched
assert r["stats"]["robots_blocked"] >= 1, r["stats"]

# ---------------------------------------------------------------------------
# 9. budgets: max_pages lowers but never leaks across crawls
# ---------------------------------------------------------------------------
site = FakeSite(dict(SITE))
c1 = Crawler(fetch=site.fetch, render=site.render)
r1 = c1.crawl("https://cafe.ge/", "deep", max_pages=1)
assert r1["stats"]["pages_fetched"] == 1, r1["stats"]

# the SAME crawler (same module-level mode table) must still get the full
# deep budget for a request that does not lower it
site2 = FakeSite(dict(SITE))
r2 = Crawler(fetch=site2.fetch, render=site2.render).crawl("https://cafe.ge/", "deep")
assert r2["stats"]["pages_fetched"] > 1, r2["stats"]
assert crawler.MODES["deep"]["max_pages"] == 25, crawler.MODES["deep"]

# max_pages can never raise the ceiling
site3 = FakeSite(dict(SITE))
r3 = Crawler(fetch=site3.fetch, render=site3.render).crawl("https://cafe.ge/", "homepage", max_pages=50)
assert r3["stats"]["pages_fetched"] <= 1, r3["stats"]

# early exit: complete business stops spending budget in key_pages mode
site4 = FakeSite({
    "https://cafe.ge/": page(links=["/contact-us", "/about"]),
    "https://cafe.ge/contact-us": page(body="Email info@cafe.ge, call +995 322 19 66 69"),
    "https://cafe.ge/about": page(body="x"),
})
r4 = Crawler(fetch=site4.fetch, render=site4.render).crawl("https://cafe.ge/", "key_pages")
assert "info@cafe.ge" in r4["contacts"]["emails"]
assert "+995322196669" in r4["contacts"]["phones"]
assert r4["stats"]["stopped_early"] is True, r4["stats"]

# mode normalisation
assert normalize_mode("deep") == "deep"
assert normalize_mode("nonsense") == crawler.DEFAULT_MODE
assert normalize_mode(None) == crawler.DEFAULT_MODE

# ---------------------------------------------------------------------------
# 10. HTTP entry points — /api/crawl (sync) and /api/jobs kind="crawl"
# ---------------------------------------------------------------------------
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)

# Drive the HTTP entry points through an injected fetcher — no real network,
# so a missing render lane (the default) can't hang the test suite.
_ep_site = FakeSite({
    "https://cafe.ge/": page(links=["/contact-us"]),
    "https://cafe.ge/contact-us": page(body="Email info@cafe.ge"),
})
_orig_fetch, _orig_render = crawler._default_fetch, crawler._default_render
crawler._default_fetch, crawler._default_render = _ep_site.fetch, _ep_site.render
try:
    resp = client.post("/api/crawl", json={"url": "https://cafe.ge/", "mode": "key_pages"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True and body["mode"] == "key_pages", body
    assert body["stats"]["pages_fetched"] >= 2, body["stats"]
    assert "info@cafe.ge" in body["contacts"]["emails"], body["contacts"]
    assert body["country"] == "GE", body            # ccTLD-derived region hint
finally:
    crawler._default_fetch, crawler._default_render = _orig_fetch, _orig_render

# bad url is a 400, not a stack trace
resp = client.post("/api/crawl", json={"url": "ftp://nope"})
assert resp.status_code == 400, resp.text

# invalid mode is rejected by the schema
resp = client.post("/api/crawl", json={"url": "https://cafe.ge/", "mode": "galactic"})
assert resp.status_code == 422, resp.text

# max_pages may LOWER a mode budget, but the schema caps it at the server ceiling
resp = client.post("/api/crawl", json={"url": "https://cafe.ge/", "mode": "deep", "max_pages": 999})
assert resp.status_code == 422, resp.text

# async path via the job queue — a bad URL surfaces as a job ERROR, matching
# how every other _dispatch kind reports HTTPException input errors.
resp = client.post("/api/jobs", json={"kind": "crawl", "payload": {"url": "ftp://nope", "mode": "homepage"}})
assert resp.status_code == 202, resp.text
job_id = resp.json()["job_id"]
for _ in range(100):
    job = client.get(f"/api/jobs/{job_id}").json()
    if job["status"] in ("done", "error"):
        break
    import time as _t
    _t.sleep(0.05)
assert job["status"] == "error", job
assert "absolute http" in (job.get("error") or ""), job

# a VALID async crawl reaches done with extracted contacts
crawler._default_fetch, crawler._default_render = _ep_site.fetch, _ep_site.render
try:
    resp = client.post("/api/jobs", json={"kind": "crawl", "payload": {"url": "https://cafe.ge/", "mode": "key_pages"}})
    assert resp.status_code == 202, resp.text
    job_id = resp.json()["job_id"]
    for _ in range(100):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            break
        import time as _t
        _t.sleep(0.05)
    assert job["status"] == "done", job
    assert "info@cafe.ge" in job["result"]["contacts"]["emails"], job["result"]
    assert job["result"]["mode"] == "key_pages", job["result"]
finally:
    crawler._default_fetch, crawler._default_render = _orig_fetch, _orig_render

print("Crawler OK")
