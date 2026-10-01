// mock_llm.cjs — deterministic OpenAI-compatible stand-in for E2E agent testing.
// Simulates a competent model: reads the LINKS list from the evidence pack,
// proposes exact contact-looking pages, and extracts unambiguous values
// already visible in the evidence. All page fetching + value validation +
// final extraction still happens in the REAL app engine — this only does
// the model's job (navigation choice + evidence reading).
const http = require('http');

const PORT = 8787;
let reqCount = 0;

function extractEvidenceValues(userPrompt) {
  // Conservative: only values plainly visible in evidence TEXT lines.
  const out = { phone: '', email: '', whatsapp: '', viber: '', telegram: '' };
  const textLines = userPrompt.split('\n').filter(l => l.startsWith('TEXT:') || !/^(URL:|TITLE:|LINKS|Business|Missing|Page evidence|Propose|Reply|When the|Known|---)/.test(l));
  const hay = textLines.join(' ');
  const em = hay.match(/[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,6}/);
  if (em && !/(example\.com|sentry|wixpress|schema|domain\.com)/i.test(em[0])) out.email = em[0];
  const ph = hay.match(/\+?\d{3}[\s(]?\d{2,3}[\s)]?\d{2}[\s-]?\d{2}[\s-]?\d{2,3}/);
  if (ph) out.phone = ph[0].trim();
  const wa = hay.match(/(?:wa\.me\/|whatsapp[^\d]{0,12})(\+?\d[\d\s-]{7,14}\d)/i);
  if (wa) out.whatsapp = wa[1].replace(/[\s-]/g, '');
  const tg = hay.match(/(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})/i);
  if (tg && !/^(share|joinchat|telegram)$/i.test(tg[1])) out.telegram = 'https://t.me/' + tg[1];
  return out;
}

function pickUrls(userPrompt) {
  const linksLine = (userPrompt.match(/LINKS \(same-site, prioritized\): ([^\n]+)/) || [])[1] || '';
  const links = linksLine.split(/\s+/).filter(u => /^https?:\/\//.test(u));
  const score = u => {
    let s = 0;
    if (/contact|kontakt|impresum|impressum|კონტაქტ/i.test(u)) s += 10;
    if (/about|aboutus|ჩვენ|შესახებ/i.test(u)) s += 6;
    if (/branch|filial|office|filiali/i.test(u)) s += 5;
    if (/\.(jpg|png|jpeg|pdf|webp|svg)(\?|$)/i.test(u)) s -= 10;
    return s;
  };
  const ranked = [...new Set(links)].filter(u => score(u) > 0).sort((a, b) => score(b) - score(a));
  if (ranked.length > 0) return ranked.slice(0, 2);
  // Real models fall back to common paths when the evidence shows no usable
  // links (JS-rendered nav, fetch failed). Emulate that so the engine gets
  // exercised on its recovery path too.
  const homepage = (userPrompt.match(/Business website: (\S+)/) || [])[1] || '';
  if (!homepage) return [];
  const root = homepage.replace(/\/$/, '');
  return [root + '/contact', root + '/about'].slice(0, 2);
}

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404, cors); res.end('not found'); return;
  }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    reqCount++;
    let user = '';
    let sys = '';
    try {
      const j = JSON.parse(body);
      for (const m of j.messages || []) {
        if (m.role === 'user') user += m.content + '\n';
        if (m.role === 'system') sys += m.content;
      }
    } catch { /* fallthrough */ }
    let content = 'PONG';
    if (!/ping/i.test(user) && !/PONG/i.test(sys)) {
      const urls = pickUrls(user);
      const vals = extractEvidenceValues(user);
      content = JSON.stringify({ urls, ...vals });
    }
    const resp = JSON.stringify({
      id: 'chatcmpl-mock-' + reqCount,
      object: 'chat.completion',
      model: 'mock-navigator-1',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(resp);
    if (content !== 'PONG') console.log(`[mock] req#${reqCount} urls=${JSON.stringify(pickUrls(user))}`);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock OpenAI-compatible LLM on http://127.0.0.1:${PORT}/v1/chat/completions`));
