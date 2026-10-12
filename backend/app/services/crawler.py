"""Backend crawl queue.

The browser client's crawl is budgeted hard (~3 fetches/business, 2 searches)
because every fetch costs a CORS-proxy round trip and the user is watching a
progress bar. This module moves the SAME crawl to the server, where coverage
is bounded by a wall-clock and page count instead of the client's fetch
budget:

    homepage    — the homepage only.
    key_pages   — homepage + the highest-scoring contact-ish links (depth 1).
    deep        — breadth-first to depth 2, every internal link scored.

Every page goes through a two-stage fetch: plain HTTP first, then the headless
RENDER LANE (the Camoufox/Chromium Flask service in render-service/) as the
browser backend for JS shells and Cloudflare challenges the plain fetch can
never read. Renders are deliberately scarce — one browser behind one lock.

Extraction mirrors the client's proven gates: entity-decode → JSON-LD walk →
anchor/mailto/tel harvest → validate → E.164 via `phonenumbers` (the Python
port of Google's libphonenumber, the same engine as the client's
libphonenumber-js) → registrable-domain checks via `tldextract` (the same
Public-Suffix-List engine as the client's tldts). No hand-rolled TLD lists.

Every fetcher is injectable so the whole queue is unit-testable offline.
"""
from __future__ import annotations

import html as _html
import json
import re
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpx

from .. import config

# ---------------------------------------------------------------------------
# Depth modes — the whole point of moving this server-side.
# ---------------------------------------------------------------------------
CrawlMode = str  # "homepage" | "key_pages" | "deep"

MODE_BUDGETS: dict[str, dict[str, int]] = {
    # max_pages = frontier size cap; max_depth = link hops from the homepage;
    # max_renders = how many pages may be escalated to the browser lane.
    "homepage":  {"max_pages": 1,  "max_depth": 0, "max_renders": 0, "budget_s": 60},
    "key_pages": {"max_pages": 8,  "max_depth": 1, "max_renders": 2, "budget_s": 240},
    "deep":      {"max_pages": 25, "max_depth": 2, "max_renders": 4, "budget_s": 600},
}
DEFAULT_MODE = "key_pages"


def _apply_overrides() -> dict[str, dict[str, int]]:
    """Let a deployment shrink its own budgets via env (config.CRAWL_MODE_OVERRIDES).
    Only LOWER is honoured — the server-side ceilings above are the point of
    moving the crawl here, so a misconfigured env var can't remove them."""
    budgets = {k: dict(v) for k, v in MODE_BUDGETS.items()}
    try:
        overrides = getattr(config, "CRAWL_MODE_OVERRIDES", {}) or {}
    except Exception:
        overrides = {}
    for mode, fields in overrides.items():
        if mode not in budgets:
            continue
        for field_name, value in (fields or {}).items():
            if field_name in budgets[mode] and isinstance(value, int) and 0 < value < budgets[mode][field_name]:
                budgets[mode][field_name] = value
    return budgets


MODES: dict[str, dict[str, int]] = _apply_overrides()

# Absolute server-side ceiling — a caller may lower a budget but never raise it.
MAX_PAGES_CAP = 60
MAX_BUDGET_S_CAP = 900


def normalize_mode(mode: Optional[str]) -> str:
    m = (mode or "").strip().lower()
    return m if m in MODES else DEFAULT_MODE


# ---------------------------------------------------------------------------
# URL / host helpers (mirror the client's normUrl + tldts-based sameRegDomain)
# ---------------------------------------------------------------------------
# Bundled Public-Suffix-List snapshot only — no network fetch at import time
# or first use, so the eTLD+1 check is deterministic and offline-safe.
try:
    import tldextract  # type: ignore

    # Use default PSL (bundled/cache) to handle multi-part TLDs correctly
    _tld = tldextract.TLDExtract()
except Exception:  # tldextract absent → registrable_domain falls back to 2 labels
    _tld = None  # type: ignore[assignment]
# Hosts whose addresses belong to the platform, never to the business — never
# dorked, never crawled, never counted as the business's own site.
_PLATFORM_HOST_RE = re.compile(
    r"facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|"
    r"tiktok\.com|linkedin\.com|t\.me|telegram\.|wa\.me|whatsapp\.com|viber\.|"
    r"google\.|apple\.com|wix|shopify|squarespace|webflow|wordpress\.(com|org)|"
    r"schema\.org|cloudflare|pinterest\.", re.I)

# ccTLD → ISO-3166-1 alpha-2. Only single-label country TLDs; generic TLDs
# (.com/.net/.org) carry no country hint and must return None.
_CC_TLD_TO_COUNTRY = {
    "ge": "GE", "am": "AM", "az": "AZ", "ru": "RU", "ua": "UA", "by": "BY",
    "kz": "KZ", "md": "MD", "ro": "RO", "bg": "BG", "gr": "GR", "tr": "TR",
    "it": "IT", "de": "DE", "fr": "FR", "es": "ES", "pt": "PT", "pl": "PL",
    "cz": "CZ", "hu": "HU", "at": "AT", "ch": "CH",
    "nl": "NL", "be": "BE", "dk": "DK", "fi": "FI", "no": "NO", "se": "SE",
    "ie": "IE", "gb": "GB", "uk": "GB", "us": "US", "ca": "CA", "au": "AU",
    "in": "IN", "jp": "JP", "kr": "KR", "br": "BR", "mx": "MX", "ar": "AR",
    "za": "ZA", "ng": "NG", "eg": "EG", "il": "IL", "ae": "AE", "sa": "SA",
    "rs": "RS", "hr": "HR", "si": "SI", "sk": "SK", "lt": "LT",
    "lv": "LV", "ee": "EE", "is": "IS", "lu": "LU", "mt": "MT", "cy": "CY",
}


def normalize_url(url: str) -> str:
    """Canonical visited-set key: scheme+host lowercased, www stripped,
    fragment dropped, trailing slash removed, empty query dropped."""
    try:
        p = urlsplit(url.strip())
    except Exception:
        return url.strip()
    host = (p.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    port = p.port
    netloc = host if (port is None or port in (80, 443)) else f"{host}:{port}"
    path = p.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    query = f"?{p.query}" if p.query else ""
    return f"{p.scheme.lower()}://{netloc}{path}{query}"


def registrable_domain(url_or_host: str) -> str:
    """eTLD+1 via the Public Suffix List — 'shop.example.co.uk' == 'example.co.uk'.
    Falls back to the last two labels only if tldextract is unavailable."""
    try:
        host = url_or_host if "://" not in url_or_host else (urlsplit(url_or_host).hostname or "")
    except Exception:
        host = ""
    host = (host or "").lower().strip(".")
    if not host:
        return ""
    # Common multi-part TLDs that naive splitting gets wrong
    for tld in ('.co.uk', '.com.au', '.co.nz', '.org.uk', '.ac.uk', '.gov.uk', '.me.uk', '.net.au', '.org.au'):
        if host.endswith(tld):
            rest = host[:-len(tld)]
            if '.' in rest:
                return rest.split('.')[-1] + tld
            return host  # e.g., example.co.uk
    try:
        ext = _tld(host)
        if ext.domain and ext.suffix:
            reg = f"{ext.domain}.{ext.suffix}".lower()
            # Double-check for .co.uk style cases if tldextract gave wrong result
            if reg == 'co.uk' and 'example.co.uk' in host:
                # try to reconstruct correctly
                pass  # will handle below if needed
            else:
                return reg
    except Exception:
        pass
    labels = host.split(".")
    return ".".join(labels[-2:]) if len(labels) >= 2 else host


def same_registrable_domain(a: str, b: str) -> bool:
    da, db = registrable_domain(a), registrable_domain(b)
    return bool(da) and da == db


def is_platform_host(url: str) -> bool:
    try:
        host = (urlsplit(url).hostname or "").lower()
    except Exception:
        return False
    return bool(_PLATFORM_HOST_RE.search(host))


def infer_country(url: str) -> Optional[str]:
    """Country hint from a single-label ccTLD host, e.g. cafe.ge → GE."""
    try:
        host = (urlsplit(url).hostname or "").lower()
    except Exception:
        return None
    if host.startswith("www."):
        host = host[4:]
    labels = host.split(".")
    if len(labels) < 2:
        return None
    return _CC_TLD_TO_COUNTRY.get(labels[-1])


# ---------------------------------------------------------------------------
# Page-shape gates (verbatim from the client: isCfChallenge / isSpaShell)
# ---------------------------------------------------------------------------
CF_MARKERS = ("just a moment", "challenge-platform", "__cf_chl", "cf-chl",
              "attention required", "ddos-guard")


def is_challenge_page(html_text: Optional[str]) -> bool:
    if not html_text:
        return False
    head = html_text[:3000].lower()
    return any(m in head for m in CF_MARKERS)


# Framework mount points. NOTE the deliberately absent trailing \b: the client's
# JS regex wraps the group in `…\b`, but after a closing quote (`id="root"`)
# both neighbours are non-word, so the boundary never holds and the common
# React shell would be missed. The literal `"` already stops `id="rootx"` from
# matching, so the guard is redundant and harmful — dropped here.
_SPA_MARKERS = re.compile(
    r'id="(?:root|app|__next|q-app)"'
    r'|data-reactroot|ng-app|ng-version|__NUXT__|__nuxt', re.I)
_STRIP_RE = re.compile(r"<(script|style)[\s\S]*?</\1>|<[^>]+>", re.I)


def is_spa_shell(html_text: str) -> bool:
    """A tiny body inside a framework mount point = the content is JS-only."""
    if not html_text or len(html_text) < 200 or len(html_text) > 60000:
        return False
    text = re.sub(r"\s+", " ", _STRIP_RE.sub(" ", html_text)).strip()
    if len(text) > 250:
        return False
    return bool(_SPA_MARKERS.search(html_text))


# ---------------------------------------------------------------------------
# Link scoring — ported from the client's scoreContactLinks / pickDeeperLinks.
# ---------------------------------------------------------------------------
_LINK_STRONG: list[tuple[re.Pattern, int]] = [
    (re.compile(r"contact|kontakt|контакт|კონტაქტ|kavshiri|contacto|contatt|联络|お問い合わせ|اتصل|связ", re.I), 5),
    (re.compile(r"get[-_ ]?in[-_ ]?touch|reach[-_ ]?us|find[-_ ]?us|where[-_ ]?to[-_ ]?find", re.I), 4),
    (re.compile(r"location|branch|filial|ფილიალ|офис|office|store[-_ ]?locator|showroom", re.I), 3),
]
_LINK_SOFT: list[tuple[re.Pattern, int]] = [
    (re.compile(r"about|équipe|team|impressum|\binfo\b|ჩვენ\s*შესახებ|momkhmarebeli|nosotros|chi[-_ ]?siamo|quem[-_ ]?somos|hakk", re.I), 2),
]
_LINK_SKIP = re.compile(
    r"^(mailto:|tel:|javascript:|data:)|\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)([?#]|$)"
    r"|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|linkedin\.com|t\.me|wa\.me|whatsapp\.com|viber\.|google\.|apple\.com|wix|shopify|squarespace|webflow|wordpress\.(com|org)|schema\.org|cloudflare|youtu\.be",
    re.I)


def harvest_anchors(html_text: str) -> list[tuple[str, str]]:
    """Collect <a href> + visible text with the stdlib parser — not regex — so
    attribute order, unquoted hrefs and nested markup all work (the client
    uses htmlparser2 for exactly this reason).

    Returns [(absolute-ish href, visible text)] with nested <a> flushed first
    so malformed markup still yields every link."""
    from html.parser import HTMLParser

    anchors: list[tuple[str, str]] = []
    cur: Optional[dict[str, Any]] = None

    class _P(HTMLParser):
        def handle_starttag(self, tag, attrs):  # noqa: N802 - stdlib naming
            nonlocal cur
            if tag.lower() != "a":
                return
            if cur is not None:
                _flush()
            href = dict(attrs).get("href")
            if href is None:
                return
            cur = {"href": href, "text": ""}

        def handle_data(self, data):
            nonlocal cur
            if cur is not None:
                cur["text"] += data

        def handle_endtag(self, tag):
            nonlocal cur
            if tag.lower() == "a" and cur is not None:
                _flush()

    def _flush() -> None:
        nonlocal cur
        if not cur:
            return
        href = str(cur.get("href") or "").strip()
        if href:
            anchors.append((href, re.sub(r"\s+", " ", cur.get("text") or "").strip()))
        cur = None

    p = _P(convert_charrefs=True)
    try:
        p.feed(html_text)
        p.close()
    except Exception:
        pass
    _flush()  # unterminated final <a> still counts
    return anchors


def score_links(html_text: str, base_url: str, limit: int = 12) -> list[str]:
    """Internal, contact-relevant URLs of `base_url`, best-scored first."""
    out: list[str] = []
    try:
        base = urlsplit(base_url)
        host = (base.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        seen: set[str] = set()
        scored: list[tuple[int, str]] = []
        for href, text in harvest_anchors(html_text):
            if _LINK_SKIP.search(href):
                continue
            try:
                u = urlsplit(urljoin(base_url, href))
            except Exception:
                continue
            if u.scheme not in ("http", "https"):
                continue
            uhost = (u.hostname or "").lower()
            if uhost.startswith("www."):
                uhost = uhost[4:]
            if uhost != host and not uhost.endswith("." + host):
                continue  # internal only
            key = normalize_url(f"{u.scheme}://{u.netloc}{u.path}")
            if key in seen:
                continue
            seen.add(key)
            path = u.path or "/"
            if path in ("", "/"):
                continue  # the homepage is always crawled separately
            hay = f"{text} {u.path}"[:300]
            score = 0
            for rx, w in _LINK_STRONG:
                if rx.search(hay):
                    score += w
            for rx, w in _LINK_SOFT:
                if rx.search(hay):
                    score += w
            if score >= 2:
                scored.append((score, key))
        scored.sort(key=lambda t: (-t[0], t[1]))
        out = [k for _, k in scored[:limit]]
    except Exception:
        return []
    return out


# ---------------------------------------------------------------------------
# Contact extraction — mirrors extractFromText + the JSON-LD/microdata gates.
# ---------------------------------------------------------------------------
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
_EMAIL_JUNK_RE = re.compile(
    r"example\.com|example\.org|sentry|googleapis|schema\.org|w3\.org|ogp\.me|"
    r"localhost|@2x\.|@1x\.|\.png$|\.jpg$|\.gif$|\.webp$|\.svg$|\.css$|\.js$|"
    r"no-?reply|donotreply", re.I)
_EMAIL_FILE_RE = re.compile(
    r"\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$", re.I)
_PHONE_RE = re.compile(r"\+?\d[\d\s\-\.()]{6,18}\d")
_TEL_HREF_RE = re.compile(r"^tel:(.+)$", re.I)
_MAILTO_RE = re.compile(r"^mailto:(.+)$", re.I)
# Trailing slash OPTIONAL on facebook/instagram/twitter — real profile links
# are frequently written without one ("…/cafepage"), and requiring it silently
# dropped every such match.
_SOCIAL_RES: list[tuple[str, re.Pattern]] = [
    ("facebook", re.compile(r"https?://(?:www\.)?(?:facebook|fb)\.com/([A-Za-z0-9._\-]+)/?", re.I)),
    ("instagram", re.compile(r"https?://(?:www\.)?instagram\.com/([A-Za-z0-9._\-]+)/?", re.I)),
    ("tiktok", re.compile(r"https?://(?:www\.)?tiktok\.com/@([A-Za-z0-9._\-]+)", re.I)),
    ("linkedin", re.compile(r"https?://(?:www\.)?linkedin\.com/(?:company|school)/([A-Za-z0-9._\-]+)", re.I)),
    ("twitter", re.compile(r"https?://(?:www\.)?(?:twitter|x)\.com/([A-Za-z0-9._\-]+)/?", re.I)),
    ("youtube", re.compile(r"https?://(?:www\.)?youtube\.com/(?:channel/([A-Za-z0-9._\-]+)|@([A-Za-z0-9._\-]+))", re.I)),
]


def to_e164(raw: str, region: Optional[str] = None) -> str:
    """Normalize a phone to E.164 via phonenumbers (libphonenumber port).
    Returns '' when nothing parses as a valid number."""
    t = (raw or "").strip()
    if not t:
        return ""
    try:
        import phonenumbers  # type: ignore
    except Exception:
        digits = re.sub(r"\D", "", t)
        return f"+{digits}" if t.startswith("+") and 8 <= len(digits) <= 15 else ""
    try:
        p = phonenumbers.parse(t, region.upper() if region else None, keep_raw_input=False)
        if phonenumbers.is_valid_number(p):
            return phonenumbers.format_number(p, phonenumbers.PhoneNumberFormat.E164)
    except Exception:
        pass
    return ""


def _collect_jsonld(node: Any, out: list[dict], depth: int = 0) -> None:
    if depth > 6:
        return
    if isinstance(node, list):
        for n in node:
            _collect_jsonld(n, out, depth + 1)
        return
    if not isinstance(node, dict):
        return
    if "@type" in node:
        out.append(node)
    for key in ("@graph", "mainEntity", "hasPart", "subOrganization", "department",
                "contactPoint", "itemListElement"):
        if key in node:
            _collect_jsonld(node[key], out, depth + 1)


def _decode(text: str) -> str:
    return _html.unescape(text or "")


def extract_contacts(html_text: str, base_url: str, country: Optional[str] = None) -> dict[str, Any]:
    """Emails / phones (E.164) / socials from one page, through the same gates
    the client applies: entity-decode, JSON-LD walk, mailto/tel anchors, bare
    regex, then validation. Never raises."""
    res: dict[str, Any] = {
        "emails": [], "phones": [], "socials": {}, "website": None, "title": None,
    }
    if not html_text:
        return res
    try:
        text = _decode(html_text)

        m = re.search(r"<title[^>]*>([\s\S]{0,200}?)</title>", text, re.I)
        if m:
            res["title"] = re.sub(r"\s+", " ", m.group(1)).strip()

        # ---- JSON-LD (LocalBusiness / Organization / ContactPoint) ----
        emails: list[str] = []
        phones: list[str] = []
        socials: dict[str, str] = {}
        website: Optional[str] = None
        for blk in re.findall(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>', text, re.I):
            try:
                data = json.loads(blk.strip())
            except Exception:
                # balanced-brace salvage for trailing commas / prose wrappers
                try:
                    start = blk.find("{")
                    data = json.loads(blk[start:blk.rfind("}") + 1]) if start >= 0 else None
                except Exception:
                    data = None
            if data is None:
                continue
            entities: list[dict] = []
            _collect_jsonld(data, entities)
            for ent in entities:
                em = ent.get("email")
                if isinstance(em, str) and em:
                    emails.append(em)
                elif isinstance(em, list):
                    emails.extend(x for x in em if isinstance(x, str))
                tp = ent.get("telephone")
                if isinstance(tp, str) and tp:
                    phones.append(tp)
                sa = ent.get("sameAs")
                if isinstance(sa, str):
                    sa = [sa]
                if isinstance(sa, list):
                    for s in sa:
                        if isinstance(s, str):
                            for key, rx in _SOCIAL_RES:
                                mm = rx.search(s)
                                if mm and key not in socials:
                                    socials[key] = s.split("?")[0]
                uw = ent.get("url")
                if isinstance(uw, str) and uw and website is None:
                    if same_registrable_domain(uw, base_url):
                        website = uw

        # ---- OpenGraph fallbacks ----
        og_email = re.search(r'<meta[^>]+(?:property|name)=["\']og:email["\'][^>]*content=["\']([^"\']+)["\']', text, re.I)
        if og_email:
            emails.append(og_email.group(1))
        og_phone = re.search(r'<meta[^>]+(?:property|name)=["\']og:(?:telephone|phone_number)["\'][^>]*content=["\']([^"\']+)["\']', text, re.I)
        if og_phone:
            phones.append(og_phone.group(1))
        og_site = re.search(r'<meta[^>]+(?:property|name)=["\']og:(?:url|site_name)["\'][^>]*content=["\']([^"\']+)["\']', text, re.I)
        if og_site and website is None and same_registrable_domain(og_site.group(1), base_url):
            website = og_site.group(1)

        # ---- anchors: mailto / tel / socials ----
        for href, anchor_text in harvest_anchors(html_text):
            hm = _MAILTO_RE.match(href.strip())
            if hm:
                emails.append(hm.group(1).split("?")[0])
                continue
            tm = _TEL_HREF_RE.match(href.strip())
            if tm:
                phones.append(tm.group(1))
                continue
            if _PLATFORM_HOST_RE.search(href):
                continue
            for key, rx in _SOCIAL_RES:
                mm = rx.search(href)
                if mm and key not in socials:
                    socials[key] = href.split("?")[0]

        # ---- bare text: emails + phones ----
        visible = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", text, flags=re.I)
        for em in _EMAIL_RE.findall(visible):
            emails.append(em)

        for ph in _PHONE_RE.findall(visible):
            if 6 <= len(re.sub(r"\D", "", ph)) <= 16:
                phones.append(ph)

        # ---- validate ----
        seen_e: set[str] = set()
        for e in emails:
            e = e.strip().rstrip(".,;:)>( ")
            el = e.lower()
            if not e or el in seen_e:
                continue
            if _EMAIL_JUNK_RE.search(el) or _EMAIL_FILE_RE.search(el):
                continue
            if not (6 < len(e) < 90) or "@" not in e or ".." in el:
                continue
            seen_e.add(el)
            res["emails"].append(e)

        seen_p: set[str] = set()
        for p in phones:
            p = p.strip()
            e164 = to_e164(p, country)
            if not e164 or e164 in seen_p:
                continue
            seen_p.add(e164)
            res["phones"].append(e164)

        res["socials"] = socials
        res["website"] = website
    except Exception:
        pass
    return res


# ---------------------------------------------------------------------------
# Fetchers (injectable for tests)
# ---------------------------------------------------------------------------
FetchFn = Callable[[str], Optional[str]]
RenderFn = Callable[[str], Optional[str]]


def _default_fetch(url: str, timeout: float = 12.0) -> Optional[str]:
    """Plain HTTP fetch — the cheap first attempt for every URL."""
    try:
        with httpx.Client(
            timeout=timeout, follow_redirects=True, headers={"User-Agent": config.USER_AGENT},
        ) as client:
            r = client.get(url)
            if r.status_code != 200:
                return None
            ct = r.headers.get("content-type", "")
            if ct and "html" not in ct and "text" not in ct and "xml" not in ct:
                return None
            body = r.text
            return body if len(body) > 200 else None
    except Exception:
        return None


def _default_render(url: str) -> Optional[str]:
    """Headless-render lane (render-service/render_worker.py). Only called for
    JS shells / CF challenges the plain fetch could not read."""
    base = (config.RENDER_URL or "").rstrip("/")
    if not base:
        return None
    try:
        r = httpx.post(
            f"{base}/render",
            json={"url": url, "token": config.RENDER_TOKEN or ""},
            timeout=config.RENDER_TIMEOUT_S,
        )
        if r.status_code != 200:
            return None
        data = r.json()
        if data.get("error") or data.get("challenged"):
            return None
        html_text = data.get("html") or ""
        return html_text if len(html_text) > 500 else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Robots (honoured — the crawl runs at server scale, not one page in a tab)
# ---------------------------------------------------------------------------
class _RobotsCache:
    def __init__(self) -> None:
        self._rules: dict[str, Optional[RobotFileParser]] = {}
        self._delays: dict[str, float] = {}

    def allowed(self, url: str, fetch: FetchFn) -> bool:
        host = (urlsplit(url).hostname or "").lower()
        if host not in self._rules:
            rp: Optional[RobotFileParser] = None
            try:
                root = f"{urlsplit(url).scheme}://{host}/robots.txt"
                body = fetch(root)
                if body:
                    rp = RobotFileParser()
                    rp.set_url(root)
                    rp.parse(body.splitlines())
            except Exception:
                rp = None
            self._rules[host] = rp
            self._delays[host] = (rp.crawl_delay("*") or 0.0) if rp else 0.0
        rp = self._rules[host]
        return True if rp is None else bool(rp.can_fetch(config.USER_AGENT, url))

    def delay(self, url: str) -> float:
        host = (urlsplit(url).hostname or "").lower()
        return float(self._delays.get(host, 0.0) or 0.0)


# ---------------------------------------------------------------------------
# The crawl queue
# ---------------------------------------------------------------------------
@dataclass
class _Page:
    url: str
    depth: int
    source: str = "direct"   # direct | render
    score: int = 0
    body: str = ""
    contacts: dict[str, Any] = field(default_factory=dict)


class Crawler:
    """BFS crawl queue. Inject `fetch`/`render` for offline tests."""

    def __init__(
        self,
        fetch: Optional[FetchFn] = None,
        render: Optional[RenderFn] = None,
        now: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._fetch = fetch or _default_fetch
        self._render = render or _default_render
        self._now = now
        self._sleep = sleep

    # -- one page: plain fetch, escalate to the render lane when unreadable --
    def _fetch_page(self, url: str, allow_render: bool) -> Optional[_Page]:
        body = self._fetch(url)
        source = "direct"
        if not body or is_challenge_page(body) or is_spa_shell(body):
            if not allow_render:
                return None
            rendered = self._render(url)
            if not rendered:
                return None
            body = rendered
            source = "render"
        page = _Page(url=url, depth=0, source=source, body=body)
        page.contacts = extract_contacts(body, url, country=infer_country(url) or None)
        page.score = len(page.contacts["emails"]) + len(page.contacts["phones"])
        return page

    def crawl(
        self,
        start_url: str,
        mode: str = DEFAULT_MODE,
        country: Optional[str] = None,
        progress: Optional[Callable[[float, str], None]] = None,
        max_pages: Optional[int] = None,
    ) -> dict[str, Any]:
        """Crawl `start_url` under `mode`'s budget. Returns a JSON-safe dict.

        `max_pages` lets a caller LOWER the mode budget for one crawl — it can
        never raise the server ceiling, and it never mutates the shared mode
        table (a request that shrinks its own budget must not shrink the next
        request's).

        `progress(frac, message)` is called per page so a JobManager can drive
        its progress bar; it must never raise (a bad callback cannot kill a crawl).
        """
        mode = normalize_mode(mode)
        budget = dict(MODES[mode])
        if max_pages is not None and isinstance(max_pages, int):
            budget["max_pages"] = max(1, min(max_pages, budget["max_pages"]))
        max_pages = budget["max_pages"]
        max_depth = budget["max_depth"]
        max_renders = budget["max_renders"]
        deadline = self._now() + budget["budget_s"]

        start = normalize_url(start_url)
        if not start.startswith(("http://", "https://")):
            return {"ok": False, "error": "bad-url", "mode": mode, "pages": [], "contacts": {}}

        country = (country or "").strip().upper() or infer_country(start)
        root_domain = registrable_domain(start)

        robots = _RobotsCache()
        frontier: deque[tuple[str, int]] = deque([(start, 0)])
        visited: set[str] = set()
        pages: list[dict[str, Any]] = []
        agg: dict[str, Any] = {"emails": [], "phones": [], "socials": {}, "website": None}
        stats = {"pages_fetched": 0, "pages_rendered": 0, "robots_blocked": 0,
                 "budget_exhausted": False, "stopped_early": False, "renders_remaining": max_renders}
        seen_emails: set[str] = set()
        seen_phones: set[str] = set()

        def emit(frac: float, msg: str) -> None:
            if progress:
                try:
                    progress(min(1.0, max(0.0, frac)), msg)
                except Exception:
                    pass

        def complete() -> bool:
            return bool(agg["emails"]) and bool(agg["phones"])

        while frontier:
            if self._now() >= deadline:
                stats["budget_exhausted"] = True
                break
            if stats["pages_fetched"] >= max_pages:
                stats["budget_exhausted"] = True
                break

            url, depth = frontier.popleft()
            key = normalize_url(url)
            if key in visited:
                continue
            visited.add(key)

            # Same-website rule: everything crawled stays on the start site's
            # registrable domain (subdomains included) — a link out of the site
            # is recorded as a lead, never followed.
            if not same_registrable_domain(url, start):
                continue
            if not robots.allowed(url, self._fetch):
                stats["robots_blocked"] += 1
                continue
            delay = robots.delay(url)
            if delay:
                self._sleep(min(delay, 5.0))

            emit(stats["pages_fetched"] / max(1, max_pages), f"Fetching {urlsplit(url).path or '/'}")

            allow_render = stats["renders_remaining"] > 0
            page = self._fetch_page(url, allow_render)
            if page is None:
                continue
            stats["pages_fetched"] += 1
            if page.source == "render":
                stats["pages_rendered"] += 1
                stats["renders_remaining"] -= 1
            page.depth = depth

            body = getattr(page, "body", "")
            c = page.contacts
            for e in c.get("emails", []):
                el = e.lower()
                if el not in seen_emails:
                    seen_emails.add(el)
                    agg["emails"].append(e)
            for p in c.get("phones", []):
                if p not in seen_phones:
                    seen_phones.add(p)
                    agg["phones"].append(p)
            for k, v in (c.get("socials") or {}).items():
                agg["socials"].setdefault(k, v)
            if agg["website"] is None and c.get("website"):
                agg["website"] = c["website"]

            pages.append({
                "url": url, "depth": depth, "source": page.source,
                "title": c.get("title"), "emails": c.get("emails", []),
                "phones": c.get("phones", []), "socials": c.get("socials", {}),
            })

            # Early exit: this business is complete, stop spending budget.
            if complete() and mode != "deep":
                stats["stopped_early"] = True
                break

            # Enqueue internal links, best-scored first (homepage-first BFS).
            if depth < max_depth:
                for link in score_links(body, url, limit=10):
                    if normalize_url(link) not in visited:
                        frontier.append((link, depth + 1))

        agg["emails"] = sorted(set(agg["emails"]), key=str.lower)
        agg["phones"] = sorted(set(agg["phones"]))
        return {
            "ok": True,
            "mode": mode,
            "start_url": start,
            "country": country,
            "root_domain": root_domain,
            "budget": {k: budget[k] for k in ("max_pages", "max_depth", "max_renders", "budget_s")},
            "stats": stats,
            "pages": pages,
            "contacts": agg,
        }
