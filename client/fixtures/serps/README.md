# SERP fixture replay — offline dork-yield comparison

## Why

The v6.9.156 email **dork sweep** (`buildEmailDorkQueries`) fires up to 3
queries per business — `"@host"`, `site:host "info@" OR …`, `"Name" city
"info@" OR …` — on top of Phase 3's old single `emailQ`
(`buildEmailQuery`). Each real query costs an engine round-trip (Brave
server budget, DDG, Bing). This harness answers **"would the dorks have
found what the old single emailQ missed?"** offline, with zero engine
calls, by replaying SAVED SERP HTML through the engine's own pipeline.

## How (v2 — production lanes, nothing copied)

`npm run replay` (standalone, NOT part of `npm test`):

1. **Fetch shim.** Before the engine module is imported, the harness
   replaces `globalThis.fetch`. Requests for `bing.com/search?q=` and
   `html.duckduckgo.com/html/?q=` are answered from
   `fixtures/serps/<engine>/<encodeURIComponent(query)>.html`; Supabase
   REST returns `null` so `cachedLane`/`pageFetchViaServer` fall through;
   anything else is a 500 (and listed in a diagnostic note).
2. **Real parsers.** The replay calls the exported production functions —
   `searchBing` (via its `cachedLane` wrapper and real `corsFetch`
   machinery) and `searchDDGHtml` — so engine parser edits show up in
   replay output immediately. There is no copied regex in the harness; a
   challenge/empty SERP self-test asserts the production Bing parser
   returns 0 results for the `empty.html` fixture.
3. **Real queries.** `buildEmailQuery` (the old single emailQ, now
   exported at module scope) vs `buildEmailDorkQueries` (≤3 dorks) — the
   exact generators production runs.
4. **Real yield metric.** Parsed titles+snippets go through
   `harvestSnippetEmails` (the production `find_email` harvester) with
   the business's own host for own-domain ranking.
5. **Ship gate.** Per business it prints
   `old=N dorks=M (gain=+k) new-only=[…] old-only=[…]` and **exits 1**
   when the dork list yields fewer addresses than the old query —
   strictly-more-yield is the condition for shipping more dorks. The gate
   was verified in both directions: normal fixtures → exit 0; an
   old-only address injected into the baseline → FAIL + exit 1.

## Fixture lookup

Per `(engine, decoded query)`:

1. **Exact**: filename (url-decoded) equals the decoded query — this is
   what real captures give you, one fixture per query.
2. **Shared-term fallback** (so a capture set can be partial): both
   queries host-scoped → same host only; one host-scoped → the other
   text must mention that host; otherwise ≥2 shared words after removing
   query keywords (`info@ contact@ office@ sales@ or and site`) and the
   scan-context words (city, native contact terms — otherwise every
   Tbilisi query matches every other Tbilisi fixture).
3. **Benign resultless page**: no fixture matched → an engine that found
   nothing. The bodies are carefully shaped to avoid the production
   challenge detectors (`akchal|challenge|verify|captcha` on Bing,
   `anomaly|challenge|captcha|blocked` on DDG) so a miss yields 0 without
   poisoning engine health for subsequent replays.

## Capturing fixtures

Run the client with devtools open, let the email phase run, and from the
Network tab copy the *response body* of each
`https://html.duckduckgo.com/html/?q=…` and `https://www.bing.com/search?q=…`
call into:

- `fixtures/serps/bing/<url-encoded query>.html`
- `fixtures/serps/ddg/<url-encoded query>.html`

The filename must be `encodeURIComponent` of the query exactly as the
generator produced it (the harness prints each query on every run — copy
from there). Include at least one empty/challenge SERP — the self-test
needs it.

## Sample fixtures

`_samples/` contains a hand-written demo set (replace with real
captures): one old-emailQ SERP per business (the A/B baseline), a dork1
`"@host"` SERP per engine, a `site:` SERP, an exact dork3 SERP, and the
`empty.html` challenge page. The demo shows the expected shape: old=1
dorks=2 for Cafe Marco (the dork-only `bookings@cafemarco.ge` is the
gain), dorks never below old anywhere.

## Adding a dork form

1. Extend `buildEmailDorkQueries`.
2. Capture (or copy) fixtures under the new query's url-encoded name.
3. Re-run `npm run replay` — the A/B table and exit code tell you
   whether the new form earns its query.
