# Deep Parse Analysis — Web + Social Media Business Contact Harvesting

**Goal:** get *almost all* emails and phone numbers about a business the way Octoparse
does — accept slower runs, spend more fetches, but win on coverage.

**Status of this doc:** analysis + roadmap. No behaviour was changed by writing it.

---

## 0. TL;DR

Blue Ocean is **not** a naive regex scraper. An audit of `client/src/clientEngine.ts`
(11,866 lines) and `client/src/contactSkills.ts` shows the pipeline already implements
roughly **80 % of what Octoparse's email/contact mode does**, and much of the
best-in-class open-source contact stack (Omkar Cloud's lineage — the code literally
says "the omkarcloud technique"):

| Octoparse capability | Already in Blue Ocean | Where |
|---|---|---|
| Link-discovery crawl, not slug guessing | ✅ | `scoreContactLinks` + "Octoparse-style link-discovery crawl" (`clientEngine.ts:90`, `:532`) |
| Stay-in-domain, max depth / max pages | ✅ | depth-2 budget, `_LINK_SKIP`, 3 fetches |
| JS-rendered + Cloudflare-protected pages | ✅ | render lane (Camoufox + Playwright) `render-service/render_worker.py` |
| JSON-LD / schema.org contactPoint | ✅ | `collectJsonLdEntities` (`:72`) |
| Microdata / microformats | ✅ | `:383`, `readMicroformats` (`deepSkills.ts:50`) |
| Cloudflare `data-cfemail` obfuscation | ✅ | `extractCfEmail` (`:10037`), `:454` |
| HTML-entity obfuscation (`&#64;`) | ✅ | `:461`, `decodeContactEntities` |
| Social bio fetch + link-in-bio hubs | ✅ | `enrichFromSocialBio` (`:4330`), linktr/beacons/taplink |
| Sitemaps, robots sitemap, WordPress API | ✅ | `discoverSitemapUrls` (`:4407`), `scrapeWordPressAPI` |
| vCard `.vcf` download + parse | ✅ | `scrapeVCard` (`:4508`), `parseVcardBlob` |
| E.164 normalization + official-contact ranking | ✅ | `toE164`, `rankOfficialPhones/Emails` |
| MX-record email-ability probe | ✅ | `domainMxProbe` (`deepSkills.ts:193`) |

So the honest answer to "what will let us parse better" is **not "switch to Octoparse's
stack"** — that is largely re-implementing what exists. It is **seven specific holes**
that currently *discard* contact data that is already sitting in pages we fetch or could
cheaply fetch. They are listed by yield below.

---

## 1. The real gaps (ranked by contacts-per-unit-effort)

### G1 — PDFs are thrown away (highest yield, zero new crawling)
`.pdf` appears in **every** file-extension skip list and is *explicitly* excluded from
crawl candidates (`clientEngine.ts:105`, `:7287`, `:9803`, `:10224`). Yet the pages most
likely to hold a phone/email — menus, brochures, price lists, company profiles, event
flyers — are PDFs. Blue Ocean finds the link, then drops it.

- **Browser-side:** [`mozilla/pdf.js`](https://github.com/mozilla/pdf.js) — already the
  reference PDF renderer, ships as an ES module, runs in Vite. `pdfjs-dist` →
  `getTextContent()`, then feed the text into the **existing** `extractFromText` /
  `findTextContacts` gates. ~1 dependency, no server.
- **Server-side (better text, tables):** [`jsvine/pdfplumber`](https://github.com/jsvine/pdfplumber)
  or [`pymupdf/PyMuPDF`](https://github.com/pymupdf/pymupdf) (fastest, best on messy
  layout). Table-heavy price lists → [`atlanhq/camelot`](https://github.com/atlanhq/camelot).
- **Plugs into:** add a `pdf` branch to the crawler that, instead of `continue`, fetches
  and routes bytes to a `pdfTextToContacts()` skill; reuse every existing validator.

### G2 — Social profiles are fetched through the *weakest* possible channel
`enrichFromSocialBio` pulls IG/FB/TikTok bios through a CORS proxy or `r.jina.ai`
(`:4312`). Those are exactly the hosts that **return login walls / blocklists to
proxies**. Meanwhile the project already owns a Camoufox lane that solves Cloudflare —
and never points it at a social profile.

- Route social-profile fetches through the **render lane** (real browser, logged-out
  public view) before falling back to jina.
- Add **platform-specific extractors** instead of the generic HTML pass:
  - Facebook `/about`, `/about_contact_and_basic_info`, `?sk=about` — the "Contact info"
    block (phone/email/website) is plain HTML in the logged-out view.
  - Instagram: bio + the "Email / Contact" button JSON; `?__a=1&__d=dis` where reachable.
  - [`instaloader`](https://github.com/instaloader/instaloader) (IG),
    [`davidteather/TikTok-Api`](https://github.com/davidteather/TikTokApi) (TikTok),
    [`kevinzg/facebook-scraper`](https://github.com/kevinzg/facebook-scraper),
    [`elliotwutingfeng/...`] / [`twscrape`] for X.
  - ⚠️ Most unauthenticated library scrapers are **broken or ban-prone in 2026**
    (`snscrape` is effectively dead after the X API change). Treat these as best-effort,
    not load-bearing.

### G3 — No deep email dorking (the "gets *all* emails" lever)
Search discovery uses Bing/DDG with business-name queries, plus `site:.tld` and
`site:yandex.*`. There is **no** `"@businessdomain.com"` query and no multi-engine email
sweep — the thing that actually surfaces the finance/hr/sales inboxes nobody puts on a
contact page.

- Add the dork set: `"@domain.tld"`, `"domain.tld" email`, `site:domain.tld`,
  `inurl:contact`, `"email" "domain.tld"`, plus per-department variants.
- Reference tool: [`laramies/theHarvester`](https://github.com/laramies/theharvester) —
  the canonical multi-source (Google/Bing/Yandex/etc.) email harvester; mine its query
  templates rather than shipping it.
- **Plugs into:** the existing `find_email` agent tool + `harvestSnippetEmails`; just add
  query templates and one more engine arm.

### G4 — Emails are collected but never *verified*
`domainMxProbe` answers "can this domain receive mail?" — nothing more. No
syntax+deliverability layer, no disposable/role classification, no catch-all detection.

- [`JoshData/python-email-validator`](https://github.com/JoshData/python-email-validator)
  (backend) — syntax + MX + optional SMTP **without sending**.
- [`reacherhq/check-if-email-exists`](https://github.com/reacherhq/check-if-email-exists)
  — Rust microservice: MX + SMTP RCPT + disposable + catch-all, returns JSON.
- Disposable lists: [`disposable-email-domains/disposable-email-domains`](https://github.com/disposable-email-domains/disposable-email-domains).
- **Plugs into:** `deepSkills.ts` next to `domainMxProbe`; the backend already proxies
  network calls, so no new CORS problem. Ship as a **microservice** (Reacher) if you want
  SMTP off the main thread.
- ⚠️ SMTP RCPT probes are increasingly blocked and look like spam; keep them **opt-in**
  and rate-limited.

### G5 — Email **pattern inference** for the people, not just the inbox
When a site yields `info@` but the outreach target is a named decision-maker, the
standard B2B move is pattern inference from the employer domain.

- [`mailmeteor`-style permutator logic] — generate `first.last`, `flast`, `firstl`, … from
  team-page names + the domain, then verify (G4) to discard wrong guesses.
- Validate against any *known* address on that domain first (e.g. `info@` never tells you
  the pattern; a `j.smith@` does) — infer the pattern from real found addresses.
- ⚠️ Permission/consent risk: only ever guess on **public professional** identities.

### G6 — Crawl scale is capped per business (client-side budget)
The whole Octoparse-style crawl runs **in the browser**, budgeted to ~3–4 fetches and
`MAX_SEARCHES = 2` per business (`:532`, `:11535`). Coverage scales with fetches; the
client cannot afford them.

- A real queue-based crawler in the **backend** with the render lane as the browser
  backend is the Octoparse shape:
  [`apify/crawlee-python`](https://github.com/apify/crawlee-python) (PlaywrightCrawler,
  autoscaling, sessions, retries) or [`scrapy/scrapy`](https://github.com/scrapy/scrapy)
  for pure-HTTP tiers; [`projectdiscovery/katana`](https://github.com/projectdiscovery/katana)
  (Go) if you want a fast standalone URL/endpoint spider as a microservice.
- Keep depth modes: `homepage` / `key_pages` / `deep` exactly like Omkar Cloud's API
  (`mode=deep` → up to 20 pages). "Slower but gets almost all" becomes a user choice.

### G7 — robots.txt is read only for sitemaps, never for permission
`:4415` fetches `robots.txt` for `Sitemap:` lines. There is **no** allow/disallow
evaluation before crawling — a compliance/legal exposure once you scale (G6).

- [`scrapy` RobotFileParser](https://github.com/scrapy/scrapy) / [`reppy`] or a ~40-line
  parser; add crawl-delay support. Cheap, and it is the responsible default.

**Bonus holes (lower yield):**
- **OCR for scanned PDFs / menu photo images** —
  [`naptha/tesseract.js`](https://github.com/naptha/tesseract.js) (browser) /
  [`ocrmypdf`](https://github.com/ocrmypdf/OCRmyPDF) (server).
- **JS-interaction extraction** — the render worker only does `goto` + `content()`
  (`render_worker.py`); no click-to-reveal-contact, no infinite scroll, no form fill.
  Add an action script param to `POST /render`.
- **Directory/SERP structured contacts** — OSM/Overpass is used; Google Maps
  ([`gosom/google-maps-scraper`](https://github.com/gosom/google-maps-scraper),
  MIT, self-hosted, `-email` visits each business site) and Yandex/2GIS return **native**
  phone numbers as structured fields, which beats inferring them.

---

## 2. Library / repo / method catalog (what to adopt, by layer)

### Crawl & orchestration
| Tool | Lang | Why |
|---|---|---|
| [`apify/crawlee-python`](https://github.com/apify/crawlee-python) | Py | PlaywrightCrawler, autoscaling, session/proxy rotation — Octoparse's engine shape |
| [`scrapy/scrapy`](https://github.com/scrapy/scrapy) | Py | Mature HTTP-tier crawl, built-in robots/delay |
| [`projectdiscovery/katana`](https://github.com/projectdiscovery/katana) | Go | Fast standalone spider (JS-aware) as a microservice |
| [`D4Vinci/Scrapling`](https://github.com/D4Vinci/Scrapling) | Py | "Adaptive" selectors that survive site redesigns |

### HTML → text / structure
| Tool | Lang | Why |
|---|---|---|
| [`scrapinghub/extruct`](https://github.com/scrapinghub/extruct) | Py | One call → JSON-LD + microdata + RDFa + microformats + OG |
| [`adbar/trafilatura`](https://github.com/adbar/trafilatura) | Py | Best-in-class main-content + metadata; beats readability on recall |
| [`mozilla/readability`](https://github.com/mozilla/readability) | JS | Browser-side main-text, already the de-facto |
| `htmlparser2` / `he` / `tldts` / `linkify-it` | JS | **already used** — keep |

### Obfuscation decoding
| Method | State |
|---|---|
| Cloudflare `data-cfemail` XOR (`byte ^ key`) | ✅ done (`extractCfEmail`) |
| `&commat;`/`&#64;` entity | ✅ done |
| `[at]`/`(dot)` bracket form | ✅ done (`_deobfuscateEmails`) |
| JS string-concat emails (`'a'+'@'+'b.com'`) | ❌ **gap** — needs JS eval or a small heuristics pass |
| CSS `display:none` / `::after{content:}` emails | ❌ **gap** — needs computed-style read in the render lane |
| Font-glyph / `unicode-range` scramble | ❌ gap (rare) |

### Validation & enrichment
`python-email-validator`, `reacherhq/check-if-email-exists`,
`disposable-email-domains`, `libphonenumber(-js)` (done), `dnspython`.
Email permutators (pattern inference) per G5.

### Social
`instaloader`, `TikTokApi`, `facebook-scraper`, `twscrape` — **best-effort only**;
prefer the render lane on logged-out public views. `snscrape` is dead.

### Directory / SERP
`gosom/google-maps-scraper` (self-host, MIT), `omkarcloud/google-maps-scraper`,
OSM/Overpass (done), Yandex/2GIS scrapers, SerpApi/SearchApi (paid, reliable).

### Documents
`pdfjs-dist` (browser), `PyMuPDF` / `pdfplumber` / `camelot` (server),
`tesseract.js` / `OCRmyPDF` (OCR).

### Anti-bot / browser
`playwright` + `camoufox` (done), `playwright-stealth` (done). Add action scripts.

---

## 3. Target architecture — "Octoparse parity"

```
                ┌──────────────────────────────────────────────┐
  client (Vite) │ fast tier: fetch → extract (existing skills)  │
                │ + PDF text (pdf.js) + dork queries            │
                └───────────────┬──────────────────────────────┘
                                │ escalate
                ┌───────────────▼──────────────────────────────┐
  backend (Py)  │ Crawlee queue · robots/delay · depth modes    │
                │ extract (extruct/trafilatura) · email verify  │
                │ PDF/OCR (PyMuPDF/OCRmyPDF) · dork sweep       │
                └───────────────┬──────────────────────────────┘
                                │ JS / anti-bot / social
                ┌───────────────▼──────────────────────────────┐
  render lane   │ Camoufox/Chromium + ACTION SCRIPTS            │
                │ (click reveal, scroll, social logged-out)     │
                └──────────────────────────────────────────────┘
```

Every tier feeds the **same** pure validators that already exist
(`plausibleEmail`, `plausiblePhone`, `toE164`, `rankOfficial*`). New tiers add *recall*;
the gates keep *precision*. That invariant is what makes "slower, gets almost all" safe.

---

## 4. Prioritized roadmap

| Pri | Item | Effort | Yield | Risk |
|---|---|---|---|---|
| **P0** | G1 PDF text → contacts (pdf.js client, PyMuPDF server) | S | **High** | none |
| **P0** | G3 `"@domain"` + multi-engine email dorks | XS | **High** | none |
| **P0** | G7 robots.txt allow/disallow + crawl-delay | XS | — | legal (low) |
| **P1** | G2 social profiles via render lane + FB `/about` extractor | M | High | ToS |
| **P1** | G4 email verification microservice (MX→SMTP→disposable) | M | Med | deliverability |
| **P1** | G6 backend Crawlee queue + depth modes | L | High | infra cost |
| **P2** | G5 email pattern inference (verified) | S | Med | consent |
| **P2** | JS-interaction action scripts in `/render` | M | Med | — |
| **P2** | OCR for scanned PDFs / menus | M | Med | cost |
| **P2** | Google Maps / Yandex structured contacts | M | High | ToS |

Do **P0 first**: three of the four are small, dependency-light, and each removes a hole
where contacts are *currently being thrown away* (PDFs) or simply never asked for (dorks).

---

## 5. Legal & ethical guardrails (do not skip before scaling)

- **robots.txt** — honour it (G7). Skipping it at Octoparse scale is the fastest route to
  an IP ban *and* a legal problem.
- **ToS** — Facebook/Instagram/LinkedIn forbid automated collection; Google Maps too.
  Prefer public, logged-out, rate-limited reads; never bypass auth. Keep these tiers
  **opt-in** and clearly labelled.
- **GDPR / personal data** — business emails at role addresses are low-risk; inferred
  *personal* addresses (G5) are personal data. Store a lawful basis + source URL per
  contact (Blue Ocean already tracks sources — keep that).
- **SMTP verification (G4)** — never send; RCPT probes only, rate-limited, and honour
  blocklists. A wrong-volume probe run gets your sending IP blacklisted.
- **Rate-limit & identify** — set a UA you can be contacted on; respect crawl-delay.

---

## 6. Quick-win code sketches

**PDF branch (client, pdf.js)** — replaces the current `continue` on `.pdf` links:

```ts
import * as pdfjs from 'pdfjs-dist';
async function pdfToContacts(url: string, b: Business): Promise<boolean> {
  const buf = await (await corsFetch(url)).arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(doc.numPages, 8); i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    text += (c.items as any[]).map(it => it.str).join(' ') + '\n';
  }
  return extractFromText(text, b);   // reuse ALL existing gates
}
```

**Email dork query templates** — appended where `find_email` builds its query:

```ts
const DORKS = (d: string) => [
  `"@${d}"`,
  `"${d}" email`,
  `site:${d} contact OR email`,
  `"${d}" "info@" OR "sales@" OR "office@"`,
];
```

**robots gate** — before enqueueing a crawl URL:

```ts
function robotsAllows(path: string, rules: {allow: string[]; disallow: string[]}) {
  const hit = (rs: string[]) => rs.some(r => r && path.startsWith(r));
  return !hit(rules.disallow) || hit(rules.allow); // longest-match nuance omitted
}
```

---

## 7. Bottom line

The parsing *engine* is already Octoparse-grade for the web; the wins now are about
**not discarding data** (PDFs), **asking the right questions** (email dorks), **using the
browser you already pay for on social** (render lane), and **removing the client's fetch
budget** (backend crawler). Adopting a whole new scraper stack would duplicate what
`clientEngine.ts` already does well.
