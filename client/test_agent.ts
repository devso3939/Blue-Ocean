// v6.9.146 unit tests: agent tool protocol + local-mode browsing + endpoint detection
// Run: npm test (tsx test_v969.ts && tsx test_agent.ts)
import { parseAgentReply, localAgentContactPages, isLocalAgentEndpoint } from './src/clientEngine.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
