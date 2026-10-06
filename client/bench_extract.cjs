#!/usr/bin/env node
/*
 * bench_extract.cjs — repeatable extraction benchmark against the 60
 * ground-truth targets in parsing_targets.json.
 *
 * The engine's ACTUAL extractor (via the __parsertest bundle) fetches every
 * target site and scores found emails/phones against known ground truth.
 * Every parser change should be measured with this before shipping:
 *
 *   node bench_extract.cjs run                      build + run CURRENT src, save bench_results/current.json
 *   node bench_extract.cjs run --ref 59f2e5a        build + run the extractor AT that git ref
 *   node bench_extract.cjs oldnew --ref 59f2e5a     baseline + current back-to-back, then compare
 *   node bench_extract.cjs compare A.json B.json    offline compare of two saved runs
 *
 * Options:
 *   --label <name>   result label / filename stem (default: current | <ref>)
 *   --strict         exit 1 if email/phone ground-truth hits regress (B < A),
 *                    after crediting back KNOWN_TRADEOFFS (documented, accepted
 *                    GT losses) — only unexpected regressions fail
 *
 * Outputs: bench_results/<label>.json + <label>.log (raw harness output).
 * Build scratch lives in _bench/ (both gitignored).
 *
 * Notes: the harness needs network; reachability varies run-to-run, so the
 * compare step warns when the two runs fetched different page counts. The
 * per-site detail blocks only list sites that yielded a contact (plus ERR
 * lines), so "only in A/B" sets can be reachability noise.
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIENT = __dirname;
const SRC = path.join(CLIENT, 'src');
const TMP = path.join(CLIENT, '_bench');
const RESULTS = path.join(CLIENT, 'bench_results');
const ESBUILD = path.join(CLIENT, 'node_modules', 'esbuild', 'bin', 'esbuild');
const ENTRY = path.join(SRC, '__parsertest.ts');
const RUN_TIMEOUT_MS = 600_000; // per harness run

function die(msg) { console.error(`bench: ${msg}`); process.exit(2); }

// Documented, ACCEPTED ground-truth losses. When --strict runs, a regression
// on exactly these site/field pairs is credited back into the delta, so only
// unexpected regressions exit 1. Add an entry here whenever a parser change
// deliberately trades a GT hit for a better answer (and say why).
const KNOWN_TRADEOFFS = [
  { field: 'phone', site: 'Sandali Metekhi',
    note: 'site publishes its landline 0322560033 in tel:/structured data; ' +
          'GT mobile +995596560033 is no longer matched (accepted in v6.9.130)' },
];

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: CLIENT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) die(`${cmd} failed: ${r.error.message}`);
  return r;
}
const node = (args, opts) => sh(process.execPath, args, opts);

// ── build ──────────────────────────────────────────────────────────────────
function build(entryPath, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const r = node([ESBUILD, entryPath, '--bundle', '--platform=node', '--format=cjs', `--outfile=${outPath}`]);
  if (r.status !== 0) { console.error(r.stderr || r.stdout); die(`esbuild failed for ${entryPath}`); }
  return outPath;
}

// Materialize src/ at a git ref into _bench/<safe>/ and bundle it. Relative
// imports are discovered transitively so future modules are picked up too.
function buildFromRef(ref) {
  const show = (repoPath) => {
    const r = sh('git', ['show', `${ref}:${repoPath}`]);
    return r.status === 0 ? r.stdout : null;
  };
  const entry = show('client/src/__parsertest.ts');
  if (entry == null) die(`git show ${ref}:client/src/__parsertest.ts failed (bad ref?)`);
  const safe = ref.replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = path.join(TMP, safe);
  fs.mkdirSync(dir, { recursive: true });

  const written = new Set();
  const queue = [['src/__parsertest.ts', entry]];
  while (queue.length) {
    const [rel, content] = queue.shift();
    if (written.has(rel)) continue;
    written.add(rel);
    // Flatten client/src/ → _bench/<ref>/ so the entry's
    // `require('../parsing_targets.json')` still resolves to
    // client/parsing_targets.json, while './x' imports resolve inside the dir.
    const outPath = path.join(dir, rel.replace(/^src\//, ''));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content);
    // The entry's `require('../parsing_targets.json')` resolves one level
    // ABOVE the materialized dir (i.e. _bench/), so keep a copy there.
    const targetsSrc = path.join(CLIENT, 'parsing_targets.json');
    if (fs.existsSync(targetsSrc)) fs.copyFileSync(targetsSrc, path.join(TMP, 'parsing_targets.json'));
    for (const m of content.matchAll(/(?:from |import )['"]\.\/([A-Za-z0-9_]+)['"]/g)) {
      const dep = `src/${m[1]}.ts`;
      if (written.has(dep)) continue;
      const body = show(`client/${dep}`);
      if (body == null) die(`${ref} is missing client/${dep} (imported by ${rel})`);
      queue.push([dep, body]);
    }
  }
  return build(path.join(dir, '__parsertest.ts'), path.join(dir, 'bundle.cjs'));
}

// ── run ────────────────────────────────────────────────────────────────────
function runHarness(bundlePath, label) {
  fs.mkdirSync(RESULTS, { recursive: true });
  console.log(`bench: running ${label} (${path.relative(CLIENT, bundlePath)}) …`);
  const t0 = Date.now();
  const r = node([bundlePath], { timeout: RUN_TIMEOUT_MS, env: { ...process.env, SMOKE_ONLY: '' } });
  const out = (r.stdout || '') + (r.stderr || '');
  const logPath = path.join(RESULTS, `${label}.log`);
  fs.writeFileSync(logPath, out);
  const ms = Date.now() - t0;
  if (r.signal) die(`${label}: harness killed after ${RUN_TIMEOUT_MS / 1000}s (see ${logPath})`);
  if (r.status !== 0) {
    console.error(out.split('\n').slice(-15).join('\n'));
    die(`${label}: harness exited ${r.status} (see ${logPath})`);
  }
  const parsed = parseHarness(out);
  if (!parsed) die(`${label}: could not parse harness output (see ${logPath})`);
  const result = {
    label, when: new Date().toISOString(), ms,
    bundle: path.relative(CLIENT, bundlePath),
    stats: parsed.stats, sites: parsed.sites, errs: parsed.errs,
  };
  fs.writeFileSync(path.join(RESULTS, `${label}.json`), JSON.stringify(result, null, 2));
  printStats(label, parsed.stats);
  console.log(`bench: ${label} ok in ${(ms / 1000).toFixed(0)}s → bench_results/${label}.json`);
  return result;
}

// ── parse harness output ───────────────────────────────────────────────────
function num(re, text, ...groups) {
  const m = text.match(re);
  if (!m) return null;
  return groups.map(g => m[g] != null ? Number(m[g]) : null);
}
function parseOverlap(tag) {
  if (!tag) return null;
  const m = tag.match(/overlap (\d+)%/);
  if (m) return Number(m[1]);
  if (/new find/.test(tag)) return -1; // no ground truth available
  return null;
}
function parseHarness(text) {
  const s = {};
  [s.tried] = num(/websites tried:\s+(\d+)/, text, 1) || [];
  const pf = num(/pages fetched:\s+(\d+) \((\d+)%\)/, text, 1, 2) || [];
  [s.fetched, s.fetchedPct] = pf;
  [s.anyContact] = num(/any contact extracted:\s+(\d+)/, text, 1) || [];
  const em = num(/emails: (\d+) ground-truth hits \+ (\d+) new finds/, text, 1, 2) || [];
  [s.emailHits, s.emailNew] = em;
  const ph = num(/phones: (\d+) ground-truth hits \+ (\d+) new finds/, text, 1, 2) || [];
  [s.phoneHits, s.phoneNew] = ph;
  const so = num(/facebook signals: (\d+), instagram: (\d+)/, text, 1, 2) || [];
  [s.facebook, s.instagram] = so;
  [s.rate] = num(/success rate on reachable pages: (\d+)%/, text, 1) || [];
  s.passed = /DIRECT PARSING PASS/.test(text);
  if (s.tried == null || s.fetched == null) return null;

  const sites = {};
  const errs = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const hd = line.match(/^✓ (.+) \((.+)\)$/);
    if (hd) { cur = sites[hd[1]] = { category: hd[2] }; continue; }
    const er = line.match(/^ERR\s+(.+?): (.*)$/);
    if (er) { errs.push({ site: er[1], error: er[2] }); cur = null; continue; }
    if (!cur || !/^ {4}\w+:\s/.test(line)) continue;
    const f = line.match(/^ {4}(email|phone|fb|ig):\s+(.*?)\s*\[([^\]]*)\]\s*$/);
    if (f) { cur[f[1]] = f[2]; cur[`${f[1]}Overlap`] = parseOverlap(f[3]); continue; }
    const plain = line.match(/^ {4}(fb|ig):\s+(\S+)\s*$/);
    if (plain) cur[plain[1]] = plain[2];
  }
  return { stats: s, sites, errs };
}

function printStats(label, s) {
  console.log(`bench: [${label}] fetched ${s.fetched}/${s.tried} (${s.fetchedPct}%), ` +
    `any-contact ${s.anyContact}, email GT ${s.emailHits}+${s.emailNew}new, ` +
    `phone GT ${s.phoneHits}+${s.phoneNew}new, rate ${s.rate}% ${s.passed ? 'PASS' : 'FAIL'}`);
}

// ── compare ────────────────────────────────────────────────────────────────
const normEmail = e => (e || '').toLowerCase().replace(/\.+$/, '');
const normPhone = p => (p || '').replace(/\D/g, '').replace(/^0+/, '');

function compare(A, B, strict) {
  console.log(`\n=== extraction benchmark: ${A.label} → ${B.label} ===`);
  console.log(`(ran ${new Date(A.when).toLocaleString('en-GB')} vs ${new Date(B.when).toLocaleString('en-GB')})`);
  const rows = [
    ['websites tried', 'tried'], ['pages fetched', 'fetched'], ['any contact', 'anyContact'],
    ['email GT hits', 'emailHits'], ['email new finds', 'emailNew'],
    ['phone GT hits', 'phoneHits'], ['phone new finds', 'phoneNew'],
    ['facebook / instagram', null], ['success rate %', 'rate'],
  ];
  const pad = (v, n) => String(v).padStart(n);
  console.log(`\n${'metric'.padEnd(22)}${pad(A.label, 12)}${pad(B.label, 12)}  Δ`);
  for (const [name, key] of rows) {
    let a, b;
    if (key == null) { a = `${A.stats.facebook}/${A.stats.instagram}`; b = `${B.stats.facebook}/${B.stats.instagram}`; }
    else { a = A.stats[key]; b = B.stats[key]; }
    const d = (key != null && a != null && b != null) ? b - a : null;
    const mark = d == null ? '' : d === 0 ? '=' : (d > 0 ? `+${d} ⚡` : `${d} ⚠`);
    console.log(`${name.padEnd(22)}${pad(a, 12)}${pad(b, 12)}  ${mark}`);
  }
  if (A.stats.fetched !== B.stats.fetched) {
    console.log(`\n⚠ reachability differed (${A.stats.fetched} vs ${B.stats.fetched} pages) — per-site deltas below may be noise.`);
  }

  const names = [...new Set([...Object.keys(A.sites), ...Object.keys(B.sites)])].sort();
  const lines = { gtLoss: [], gtGain: [], gained: [], lost: [], changed: [], onlyA: [], onlyB: [] };
  for (const n of names) {
    const a = A.sites[n], b = B.sites[n];
    if (!a) { lines.onlyB.push(n); continue; }
    if (!b) { lines.onlyA.push(n); continue; }
    for (const f of ['email', 'phone']) {
      const av = a[f], bv = b[f];
      const ao = a[`${f}Overlap`], bo = b[`${f}Overlap`];
      const aHit = ao != null && ao > 0, bHit = bo != null && bo > 0;
      const same = f === 'email' ? normEmail(av) === normEmail(bv) : normPhone(av) === normPhone(bv);
      if (!av && bv) lines.gained.push(`${f} ${n}: ${bv} [${bo == null ? 'no truth' : bo + '%'}]`);
      else if (av && !bv) lines.lost.push(`${f} ${n}: ${av} [${ao == null ? 'no truth' : ao + '%'}]`);
      else if (av && bv && !same) {
        lines.changed.push(`${f} ${n}: ${av} [${ao ?? '?'}%] → ${bv} [${bo ?? '?'}%]`);
        if (aHit && !bHit) lines.gtLoss.push(`${f} ${n}: ${av} [${ao}%] → ${bv} [${bo ?? '?'}%]`);
        if (!aHit && bHit) lines.gtGain.push(`${f} ${n}: ${bv} [${bo}%]`);
      } else if (av && bv && same && aHit !== bHit) {
        (bHit ? lines.gtGain : lines.gtLoss).push(`${f} ${n}: overlap ${ao}% → ${bo}%`);
      }
    }
  }
  const emit = (title, arr) => {
    if (!arr.length) return;
    console.log(`\n${title} (${arr.length}):`);
    for (const l of arr.slice(0, 25)) console.log(`  ${l}`);
    if (arr.length > 25) console.log(`  … +${arr.length - 25} more`);
  };
  emit('GT HIT LOST (regressions)', lines.gtLoss);
  emit('GT HIT GAINED', lines.gtGain);
  emit('newly found (field was empty)', lines.gained);
  emit('no longer found', lines.lost);
  emit('value changed', lines.changed);
  emit(`only in ${A.label} (reachability?)`, lines.onlyA);
  emit(`only in ${B.label} (reachability?)`, lines.onlyB);

  const emailDelta = B.stats.emailHits - A.stats.emailHits;
  const phoneDelta = B.stats.phoneHits - A.stats.phoneHits;

  // Credit back regressions that match a documented known tradeoff: the loss
  // must actually manifest in this comparison (per-site evidence), otherwise
  // the credit doesn't apply and a real regression still fails.
  const credit = { email: 0, phone: 0 };
  for (const t of KNOWN_TRADEOFFS) {
    const prefix = `${t.field} ${t.site}:`;
    const regressed = lines.gtLoss.some(l => l.startsWith(prefix)) ||
      lines.lost.some(l => l.startsWith(prefix)) || lines.onlyA.includes(t.site);
    if (regressed) {
      credit[t.field]++;
      console.log(`\nknown tradeoff (${t.field} ${t.site}) — not counted as a regression: ${t.note}`);
    }
  }
  const emailEff = emailDelta + credit.email;
  const phoneEff = phoneDelta + credit.phone;
  const fmt = (d, c) => {
    const s = d === 0 ? '=' : d > 0 ? `+${d}` : String(d);
    return c ? `${s} (raw ${d}, tradeoff +${c} → ${d + c})` : s;
  };
  console.log(`\nverdict: email GT ${fmt(emailDelta, credit.email)}, phone GT ${fmt(phoneDelta, credit.phone)}`);
  if (strict && (emailEff < 0 || phoneEff < 0)) {
    console.error('STRICT: ground-truth hits regressed (beyond known tradeoffs)');
    process.exit(1);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────
function argValue(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
const strict = process.argv.includes('--strict');

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*|^ \* ?/gm, ''));
  process.exit(0);
}
if (cmd === 'run') {
  const ref = argValue('--ref');
  const label = argValue('--label') || (ref ? ref.replace(/[^A-Za-z0-9_.-]/g, '_') : 'current');
  const bundle = ref ? buildFromRef(ref) : build(ENTRY, path.join(TMP, 'current.cjs'));
  runHarness(bundle, label);
} else if (cmd === 'oldnew') {
  const ref = argValue('--ref');
  if (!ref) die('oldnew requires --ref <gitref> (the baseline to compare against)');
  const baseLabel = argValue('--label') || ref.replace(/[^A-Za-z0-9_.-]/g, '_');
  const A = runHarness(buildFromRef(ref), baseLabel);
  const B = runHarness(build(ENTRY, path.join(TMP, 'current.cjs')), 'current');
  compare(A, B, strict);
} else if (cmd === 'compare') {
  const [fa, fb] = rest.filter(a => !a.startsWith('--'));
  if (!fa || !fb) die('compare <a.json> <b.json>');
  const load = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die(`cannot read ${p}: ${e.message}`); } };
  compare(load(fa), load(fb), strict);
} else {
  die(`unknown command "${cmd}" — use run | oldnew | compare (see --help)`);
}
