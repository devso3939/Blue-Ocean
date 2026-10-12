// v6.9.146 unit tests: agent tool protocol + local-mode browsing + endpoint detection
// Run: npm test (tsx test_v969.ts && tsx test_agent.ts)
import { parseAgentReply, localAgentContactPages, isLocalAgentEndpoint, harvestSnippetEmails, harvestSnippetPhones, buildEmailDorkQueries, buildEmailQuery, setScanContext } from './src/clientEngine.js';

// node shim for bare test run (tsconfig excludes test files)
declare const process: { exit: (code: number) => void };

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

// ── parseAgentReply: one JSON tool call per turn ─────────────────

// 1. fetch_page tool
eq('tool: fetch_page',
  parseAgentReply('{"tool":"fetch_page","url":"https://example.com/contact"}'),
  { tool: 'fetch_page', url: 'https://example.com/contact' });

// 2. action-alias form (models vary: action vs tool, fetch vs fetch_page)
eq('tool: action=open alias',
  parseAgentReply('{"action":"open","url":"https://example.com/about"}'),
  { tool: 'fetch_page', url: 'https://example.com/about' });

// 3. search tool (escaped quotes inside the JSON string value)
eq('tool: search',
  parseAgentReply('{"tool":"search","query":"\\"Cafe Marco\\" Tbilisi contact"}'),
  { tool: 'search', query: '"Cafe Marco" Tbilisi contact' });

// 4. contacts turn — flat keys
eq('tool: contacts flat',
  parseAgentReply('{"tool":"contacts","phone":"+995 322 55 05 05","email":"info@aversi.ge"}'),
  { tool: 'contacts', found: { phone: '+995 322 55 05 05', email: 'info@aversi.ge', whatsapp: undefined, viber: undefined, telegram: undefined, social: undefined }, next: undefined });

// 5. contacts nested under "contacts"
eq('tool: contacts nested',
  parseAgentReply('{"contacts":{"whatsapp":"+995555123456"}}'),
  { tool: 'contacts', found: { phone: undefined, email: undefined, whatsapp: '+995555123456', viber: undefined, telegram: undefined, social: undefined }, next: undefined });

// 6. legacy v6.9.127 format — urls + values in one reply
const legacy = parseAgentReply('{"urls":["https://example.com/contact-us"],"phone":"+1 555 0100"}');
const legacyContacts = legacy?.tool === 'contacts' ? legacy : null;
eq('tool: legacy urls→next', legacyContacts?.next, { tool: 'fetch_page', url: 'https://example.com/contact-us' });
eq('tool: legacy phone applied', legacyContacts?.found.phone, '+1 555 0100');

// 7. markdown fence + chatter tolerated
eq('tool: fenced json',
  parseAgentReply('Sure! Here you go:\n```json\n{"tool":"fetch_page","url":"https://x.ge/ka/contact"}\n```'),
  { tool: 'fetch_page', url: 'https://x.ge/ka/contact' });

// 8. prose without JSON → null (caller retries once, then stops)
eq('prose → null', parseAgentReply('I think the contact page is on the about section.'), null);
eq('empty → null', parseAgentReply(''), null);
eq('unknown tool → null', parseAgentReply('{"tool":"teleport","url":"https://x"}'), null);
eq('fetch without url → null', parseAgentReply('{"tool":"fetch_page"}'), null);
eq('search without query → null', parseAgentReply('{"tool":"search"}'), null);

// ── localAgentContactPages: heuristic page picker (no model) ─────

const BASE = 'https://example-cafe.ge/';

// 9. scored contact links win
{
  const html = '<a href="/contact-us/">Contact Us</a><a href="/menu/">Menu</a><a href="/branches/vake">Branches</a>';
  const out = localAgentContactPages(html, BASE);
  eq('scored: /contact-us/ picked', out.some(u => u.includes('/contact-us')), true);
  eq('scored: menu excluded', out.every(u => !u.includes('/menu')), true);
}

// 10. thin nav (nothing scores) → classic slug fallbacks
{
  const html = '<a href="/menu">Menu</a><a href="/gallery">Gallery</a>';
  const out = localAgentContactPages(html, BASE);
  eq('fallback: has /contact', out.some(u => u.endsWith('/contact')), true);
  eq('fallback: has /contact-us', out.some(u => u.includes('/contact-us')), true);
  eq('fallback: cap ≤ 4', out.length <= 4, true);
}

// 11. empty html → fallbacks still offered
{
  const out = localAgentContactPages('', BASE);
  eq('empty html → fallbacks', out.length >= 3 && out[0].includes('example-cafe.ge'), true);
}

// 12. dedupe: same page via scored link + fallback guess appears once
{
  const html = '<a href="/contact">Contact</a>';
  const out = localAgentContactPages(html, BASE);
  const contactish = out.filter(u => u.replace(/\/+$/, '').endsWith('/contact'));
  eq('dedupe scored vs fallback', contactish.length, 1);
}

// 13. malformed base → no throw, empty-ish result
{
  const out = localAgentContactPages('<a href="/contact">c</a>', 'not-a-url');
  eq('malformed base tolerated', Array.isArray(out), true);
}

// ── isLocalAgentEndpoint: key optional only for local models ─────

eq('localhost:11434 → local', isLocalAgentEndpoint('http://localhost:11434/v1'), true);
eq('127.0.0.1 → local', isLocalAgentEndpoint('http://127.0.0.1:1234/v1'), true);
eq('192.168.x → local', isLocalAgentEndpoint('http://192.168.1.20:8080/v1'), true);
eq('10.x → local', isLocalAgentEndpoint('http://10.0.0.5:8080/v1'), true);
eq('openai → NOT local', isLocalAgentEndpoint('https://api.openai.com/v1'), false);
eq('openrouter → NOT local', isLocalAgentEndpoint('https://openrouter.ai/api/v1'), false);
eq('evil localhost-like host → NOT local', isLocalAgentEndpoint('https://localhost.evil.com/v1'), false);
eq('garbage → NOT local', isLocalAgentEndpoint('not a url'), false);

// ── v6.9.151: localAgentContactPages harvests mailto: hrefs ──────

{
  const html = '<html><body><a href="mailto:info@harvest.ge">mail</a><a href="/contact">c</a><a href="tel:+995322196669">call</a></body></html>';
  const out = localAgentContactPages(html, 'https://harvest.ge/');
  eq('mailto harvest: mailto present', out.some(u => u.startsWith('mailto:info@harvest.ge')), true);
}
{
  // no mailto → no mailto entries
  const out = localAgentContactPages('<a href="/about">a</a>', 'https://x.ge/');
  eq('mailto harvest: none when absent', out.some(u => u.startsWith('mailto:')), false);
}
{
  // deduped: two identical mailto hrefs → one entry
  const html = '<a href="mailto:dup@dup.ge">1</a><a href="mailto:dup@dup.ge">2</a>';
  const out = localAgentContactPages(html, 'https://dup.ge/');
  eq('mailto harvest: deduped', out.filter(u => u === 'mailto:dup@dup.ge').length, 1);
}
{
  // works even when the scorer finds no pages (thin nav)
  const out = localAgentContactPages('<a href="mailto:solo@solo.ge">m</a>', 'https://solo.ge/');
  eq('mailto harvest: thin-nav page still harvested', out.some(u => u.startsWith('mailto:solo@solo.ge')), true);
}

// ── v6.9.152: harvestSnippetEmails — find_email tool core ─────────

{
  const out = harvestSnippetEmails([
    'Cafe Orient — contact us at info@orient.ge or call +995 322 19 66 69',
    'Orient cafe Tbilisi · orient@mail.ru page',
  ], 'orient.ge');
  eq('snippet: own-domain first', out[0], 'info@orient.ge');
  eq('snippet: platform host rejected', out.includes('orient@mail.ru'), false);
}
{
  // junk + garbage TLD filtered
  const out = harvestSnippetEmails([
    'noreply@example.com posted sentry@wixpress.com thing@foo.primary',
    'valid: office@acme.ge',
  ]);
  eq('snippet: junk/platform/TLD filtered', out, ['office@acme.ge']);
}
{
  // deduped across snippets + entity-decoded (&#64;)
  const out = harvestSnippetEmails([
    'write to hi&#64;dup.ge today',
    'also hi@dup.ge here',
  ]);
  eq('snippet: deduped + entity decoded', out, ['hi@dup.ge']);
}
{
  // no domain argument — still returns all valid ones in order
  const out = harvestSnippetEmails(['a@one.ge then b@two.ge']);
  eq('snippet: no domain arg', out, ['a@one.ge', 'b@two.ge']);
}
eq('snippet: empty input → []', harvestSnippetEmails([]), []);

// ── v6.9.152: parseAgentReply understands find_email ─────────────

{
  const call = parseAgentReply('{"tool":"find_email","query":"site:orient.ge email"}');
  eq('find_email: parsed', call, { tool: 'find_email', query: 'site:orient.ge email' });
}
eq('find_email: query alias q works', parseAgentReply('{"tool":"find_email","q":"x@y"}')?.tool, 'find_email');
eq('find_email: missing query → null', parseAgentReply('{"tool":"find_email"}'), null);

// ── v6.9.153: harvestSnippetPhones — harvest_phone tool core ─────

{
  const out = harvestSnippetPhones([
    'Cafe Orient — call us: tel:+995322196669 or +995 322 19 66 69',
    'Orient cafe Tbilisi · open 9-18, seats 120',
  ], 'GE');
  eq('phone snippet: tel: href harvested + normalized', out[0], '+995322196669');
  eq('phone snippet: digit-run duplicate collapsed', out.length, 1);
  eq('phone snippet: non-phones rejected', out.some(p => p.includes('120') || p.includes('18')), false);
}
{
  // local-format number + scan region → E.164 through the same pipeline
  const out = harvestSnippetPhones(['Tel: 0 322 19 66 69 today'], 'GE');
  eq('phone snippet: region-aware E.164', out, ['+995322196669']);
}
{
  // international format survives without region; garbage digits dropped
  const out = harvestSnippetPhones(['ring +1-555-0100 now; ref 20241009']);
  eq('phone snippet: intl survives w/o region', out, ['+15550100']);
  eq('phone snippet: id-like digits dropped', out.includes('20241009'), false);
}
eq('phone snippet: empty input → []', harvestSnippetPhones([]), []);

// ── v6.9.153: parseAgentReply understands harvest_phone ───────────

{
  const call = parseAgentReply('{"tool":"harvest_phone","query":"site:orient.ge phone"}');
  eq('harvest_phone: parsed', call, { tool: 'harvest_phone', query: 'site:orient.ge phone' });
}
eq('harvest_phone: query alias q works', parseAgentReply('{"tool":"harvest_phone","q":"x"}')?.tool, 'harvest_phone');
eq('harvest_phone: legacy find_phone alias → harvest_phone',
  parseAgentReply('{"tool":"find_phone","query":"y"}'),
  { tool: 'harvest_phone', query: 'y' });
eq('harvest_phone: missing query → null', parseAgentReply('{"tool":"harvest_phone"}'), null);

// ── v6.9.154: reply-parsing hardening (agentJson + agentStr) ──────
// Local models emit: prose around the object, trailing commas, single
// quotes, unquoted keys, and numeric digit-values. None may kill the turn.

{
  const call = parseAgentReply('Sure — use this: {"tool":"search","query":"x",}');
  eq('json: prose before + trailing comma', call, { tool: 'search', query: 'x' });
}
{
  const call = parseAgentReply('Use {this} then {"tool":"fetch_page","url":"https://x.ge/c"} done');
  eq('json: prose braces ignored', call?.tool, 'fetch_page');
}
{
  const call = parseAgentReply("{'tool':'search','query':'y'}");
  eq('json: single quotes repaired', call, { tool: 'search', query: 'y' });
}
{
  const call = parseAgentReply('{tool:"search",query:"z"}');
  eq('json: unquoted keys repaired', call, { tool: 'search', query: 'z' });
}
eq('json: numeric phone value coerced',
  parseAgentReply('{"tool":"contacts","phone":995322196669}')?.found?.phone,
  '995322196669');
eq('json: fenced + trailing prose with braces',
  parseAgentReply('```json\n{"tool":"harvest_phone","query":"q"}\n``` (fields: {})')?.tool,
  'harvest_phone');
eq('json: garbage still null', parseAgentReply('{no quotes here at all}'), null);

// ── v6.9.154: harvestSnippetPhones unicode + sentence hardening ──

{
  // en-dash separators (CMS typography) must not drop the number
  const out = harvestSnippetPhones(['Call +995\u2013322\u201319\u201366\u201369 today'], 'GE');
  eq('phone: en-dash separators normalized', out, ['+995322196669']);
}
{
  // non-breaking spaces between groups (copied from PDF/Word pages)
  const out = harvestSnippetPhones(['Tel:\u00a0+995\u00a0322\u00a019\u00a066\u00a069'], 'GE');
  eq('phone: nbsp groups normalized', out, ['+995322196669']);
}
{
  // sentence boundary: hours fragment must not merge with the real number
  const out = harvestSnippetPhones(['Open 9-18. Call +995322196669'], 'GE');
  eq('phone: sentence split prevents merge', out, ['+995322196669']);
}

// ── v6.9.156: buildEmailDorkQueries — "@domain" + per-department dorks ──

{
  const qs = buildEmailDorkQueries({ name: 'Shavi Coffee', website: 'https://www.cafe.ge/', address: '1 Tbilisi' } as never);
  const d = qs.map(decodeURIComponent);
  eq('dork: bounded to 3', qs.length <= 3, true);
  eq('dork: @domain form first', d[0], '"@cafe.ge"');
  eq('dork: site: + department form', d.some(x => x.startsWith('site:cafe.ge "info@"')), true);
  eq('dork: per-department list', d.some(x => x.includes('"sales@"') && x.includes('"office@"')), true);
  eq('dork: name fallback present', d.some(x => x.includes('Shavi Coffee')), true);
  eq('dork: www stripped from host', d.some(x => x.includes('@www.')) || d.some(x => x.includes('site:www.')), false);
  eq('dork: returned encoded', qs.some(x => x.includes('%22')), true);
  eq('dork: no raw spaces', qs.every(x => !x.includes(' ')), true);
}
{
  // no website yet → no host dork, but the name/department form still fires
  const qs = buildEmailDorkQueries({ name: 'Shavi Coffee', website: '' } as never);
  const d = qs.map(decodeURIComponent);
  eq('dork: no host dork without website', d.some(x => x.startsWith('"@')), false);
  eq('dork: name dork without website', d.some(x => x.includes('Shavi Coffee')), true);
  eq('dork: no undefined leak', qs.every(x => !x.includes('undefined')), true);
  eq('dork: no empty string queries', qs.every(x => x.length > 8), true);
}
{
  // aggregator hosts are never dorked — the address belongs to the platform
  const qs = buildEmailDorkQueries({ name: 'Some Cafe', website: 'https://facebook.com/somepage' } as never);
  const d = qs.map(decodeURIComponent);
  eq('dork: aggregator host skipped', d.some(x => x.includes('@facebook.com') || x.startsWith('site:facebook.com')), false);
}
{
  // nameless business still yields the host dorks
  const qs = buildEmailDorkQueries({ name: '', website: 'https://shop.acme.co.uk/' } as never);
  const d = qs.map(decodeURIComponent);
  eq('dork: host dork without name', d.includes('"@shop.acme.co.uk"'), true);
  eq('dork: subdomain kept', d.some(x => x.startsWith('site:shop.acme.co.uk')), true);
}
{
  // a digit-bearing address TAIL is a street, not a city — keeping it would
  // AND the query down to nothing and burn one of the 3 dork slots
  const qs = buildEmailDorkQueries({ name: 'Shavi Coffee', website: 'https://cafe.ge/', address: '12a Tbilisi' } as never);
  const d = qs.map(decodeURIComponent);
  eq('dork: street tail dropped', d.some(x => x.includes('Shavi Coffee') && x.includes('12a')), false);
  eq('dork: street case still has name dork', d.some(x => x.includes('Shavi Coffee')), true);
}
{
  // garbage website must not produce a malformed dork
  const qs = buildEmailDorkQueries({ name: 'X', website: 'not a url' } as never);
  const d = qs.map(decodeURIComponent);
  eq('dork: bad website → no host dork', d.some(x => x.startsWith('"@') || x.startsWith('site:')), false);
  eq('dork: bad website → no undefined', qs.every(x => !x.includes('undefined')), true);
}

// ── buildEmailQuery: the old single emailQ baseline (hoisted to module
// scope in the harness round — guard that the export still yields a
// sane encoded query, since `npm run replay` grades dorks against it) ──
setScanContext({ countryCode: 'GE', countryName: 'Georgia', lang: 'ka', cityNative: 'თბილისი', cityEn: 'Tbilisi' } as never);
{
  const raw = buildEmailQuery({ name: 'Cafe Marco', website: 'https://cafemarco.ge/', address: '12a Rustaveli Ave, Tbilisi', categoryLabel: 'Cafe' } as never);
  const dec = decodeURIComponent(raw);
  eq('emailQ: encoded non-empty', raw.length > 0 && !raw.includes(' '), true);
  eq('emailQ: business name quoted', dec.includes('"Cafe Marco"'), true);
  eq('emailQ: no undefined leakage', dec.includes('undefined'), false);
  eq('emailQ: native contact terms present', dec.includes('კონტაქტი') || dec.includes('contact'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
