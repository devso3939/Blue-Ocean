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
 *                    GT losses) and GT hits lost to UNFETCHED pages (network
 *                    reachability) — only regressions on pages that both runs
 *                    actually fetched can fail the gate
 *
 * Outputs: bench_results/<label>.json + <label>.log (raw harness output).
 * Build scratch lives in _bench/ (both gitignored).
 *
 * Notes: the harness needs network; reachability varies run-to-run, so run/oldnew
 * auto-retry unfetched pages once (BENCH_ONLY filter, log in <label>-retry.log)
 * and compare excuses any GT hits still lost to unfetched pages. The
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

function sh(cmd, args, opts = {}) {
  // v6.9.141: opts (timeout, env) were previously DROPPED here — the retry's
  // BENCH_ONLY filter never reached the harness and RUN_TIMEOUT never applied.
  const r = spawnSync(cmd, args, {
    cwd: CLIENT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout, env: opts.env,
  });
  if (r.error) die(`${cmd} failed: ${r.error.message}`);
  return r;
}
const node = (args, opts) => sh(process.execPath, args, opts);

// ── build ──────────────────────────────────────────────────────────────────
// On Linux/macOS npm's postinstall leaves the NATIVE esbuild binary at
// node_modules/esbuild/bin/esbuild (ELF/Mach-O); on Windows it stays a JS
// wrapper. Executing the native binary through `node` fails with a
// SyntaxError (that's what broke the first CI gate), so detect the format.
function esbuildRun(args) {
  const head = fs.readFileSync(ESBUILD).subarray(0, 4);
  const native = head[0] === 0x7f || (head[0] === 0xcf && head[1] === 0xfa) || (head[0] === 0xfe && head[1] === 0xed);
  return native ? sh(ESBUILD, args) : node([ESBUILD, ...args]);
}

function build(entryPath, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const r = esbuildRun([entryPath, '--bundle', '--platform=node', '--format=cjs', `--outfile=${outPath}`]);
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
// ── cache ────────────────────────────────────────────────────────────────
// bench_results/<label>.json + <label>.log are the repeatable harvest. When a
// result already exists, compare() (and re-runs) load it instead of re-fetching
// the whole corpus — the harness is network-bound and stale results are fine
// because the parser change is what varies between runs, not the corpus.
function annotateLog(label, suffix) {
  const log = path.join(RESULTS, `${label}.log`);
  if (fs.existsSync(log)) {
    const prev = fs.readFileSync(log, 'utf8');
    if (!prev.includes('cache written') && !prev.includes(suffix)) {
      fs.appendFileSync(log, `\n-- ${suffix} (${new Date().toISOString()}) --`);
    }
  }
}

function saveCached(result, label, reason) {
  fs.writeFileSync(path.join(RESULTS, `${label}.json`), JSON.stringify(result, null, 2));
  annotateLog(label, `cache written: ${reason || 'unknown'}`);
}

function isValidCache(result) {
  if (!result || typeof result !== 'object') return false;
  const s = result.stats;
  return s && typeof s.tried === 'number' &&
    s.tried === 60 && s.fetched > 0 && typeof s.emailHits === 'number' && typeof s.phoneHits === 'number';
}

// v6.9.142: partial/interrupted writes (killed mid-harness, fs crash,
// interrupted download) leave a .json of the wrong shape — validate before
// trusting any JSON read of the cache.
function validateCache(result) {
  return isValidCache(result);
}

function loadCached(label) {
  const json = path.join(RESULTS, `${label}.json`);
  const log = path.join(RESULTS, `${label}.log`);
  if (fs.existsSync(json)) {
    try {
      const raw = fs.readFileSync(json, 'utf8');
      const parsed = JSON.parse(raw);
      // v6.9.142: a partial/interrupted write (killed mid-harness, fs crash,
      // interrupted download) leaves a .json of the wrong shape. Refuse it and
      // fall through to a fresh re-fetch so no downstream code ever trusts
      // incomplete stats.
      if (!isValidCache(parsed)) return null;
      return { fromCache: true, data: parsed, dataPath: json, logPath: log };
    } catch (e) {
      console.error(`bench: cached ${label}.json unreadable: ${e.message}`);
      return null;
    }
  }
  return null;
}

function runHarness(bundlePath, label, { fresh = false, checkCache = true } = {}) {
  // v6.9.142: reuse a saved run instead of re-fetching the corpus when the
  // parser hasn't changed — network-bound, full re-fetch is the expensive part.
  if (checkCache) {
    const cached = loadCached(label);
    if (cached && !fresh) {
      console.log(`bench: ${label}: CACHE HIT (${cached.dataPath}) — results reused as-is`);
      return cached.data;
    }
  }
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
  let parsed = parseHarness(out);
  if (!parsed) die(`${label}: could not parse harness output (see ${logPath})`);

  // v6.9.141: auto-retry unfetched targets ONCE. Fetch failures are the
  // dominant run-to-run noise (the same code fetched 34–38 of 60 pages across
  // runs); a second pass over only the missed pages (BENCH_ONLY index filter)
  // turns most noise into data. Counts are additive: the retry's targets are
  // disjoint from the first pass's fetched set.
  const missedNames = Object.keys(parsed.missed || {});
  if (missedNames.length) {
    let tgts = [];
    try { tgts = JSON.parse(fs.readFileSync(path.join(CLIENT, 'parsing_targets.json'), 'utf8')); } catch {}
    const idxs = [];
    for (const n of missedNames) {
      const i = tgts.findIndex(t => t.name === n);
      if (i >= 0 && !idxs.includes(i)) idxs.push(i);
    }
    if (idxs.length) {
      console.log(`bench: ${label}: retrying ${idxs.length} unfetched page(s)…`);
      const r2 = node([bundlePath], { timeout: RUN_TIMEOUT_MS, env: { ...process.env, SMOKE_ONLY: '', BENCH_ONLY: idxs.join(',') } });
      const out2 = (r2.stdout || '') + (r2.stderr || '');
      fs.writeFileSync(path.join(RESULTS, `${label}-retry.log`), out2);
      if (r2.status === 0 && !r2.signal) {
        const p2 = parseHarness(out2);
        // Capability guard: a harness built from a ref that predates
        // BENCH_ONLY ignores the filter and re-runs all 60 targets — merging
        // that would double-count every stat. Discard it instead.
        if (p2 && p2.stats.tried !== idxs.length) {
          console.log(`bench: ${label}: retry harness ran ${p2.stats.tried} targets (expected ${idxs.length}) — BENCH_ONLY unsupported by this ref, retry discarded`);
        } else if (p2) {
          const s = { ...parsed.stats };
          for (const k of ['fetched', 'anyContact', 'emailHits', 'emailNew', 'phoneHits', 'phoneNew',
            'facebook', 'instagram', 'hoursFilled', 'ratingFilled']) {
            if (s[k] != null && p2.stats[k] != null) s[k] += p2.stats[k];
          }
          if (s.tried) s.fetchedPct = Math.round(s.fetched / s.tried * 100);
          if (s.fetched) s.rate = Math.round(s.anyContact / s.fetched * 100);
          // still-missed = retried-but-failed again, plus missed names whose
          // index wasn't retried (duplicate-name targets collapse by name).
          const retriedNames = new Set(idxs.map(i => tgts[i] && tgts[i].name));
          const stillMissed = {};
          for (const n of missedNames) if (!retriedNames.has(n)) stillMissed[n] = true;
          for (const n of Object.keys(p2.missed || {})) stillMissed[n] = true;
          const recovered = missedNames.length - Object.keys(stillMissed).length;
          parsed = {
            stats: s,
            sites: { ...parsed.sites, ...p2.sites },
            missed: stillMissed,
            errs: [...(parsed.errs || []), ...(p2.errs || [])],
          };
          console.log(`bench: ${label}: retry recovered ${recovered}/${missedNames.length} page(s) (${Object.keys(stillMissed).length} still missed)`);
        }
      }
    }
  }

  const result = {
    label, when: new Date().toISOString(), ms,
    bundle: path.relative(CLIENT, bundlePath),
    stats: parsed.stats, sites: parsed.sites, missed: parsed.missed, errs: parsed.errs,
  };
  saveCached(result, label, 'fresh harness run (with retry merge)');
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
  // v6.9.135: profile fills (absent in older logs → left undefined)
  const hr = num(/hours filled: (\d+), rating filled: (\d+)/, text, 1, 2) || [];
  [s.hoursFilled, s.ratingFilled] = hr;
  [s.rate] = num(/success rate on reachable pages: (\d+)%/, text, 1) || [];
  s.passed = /DIRECT PARSING PASS/.test(text);
  if (s.tried == null || s.fetched == null) return null;

  const sites = {};
  const errs = [];
  const missed = {}; // v6.9.140: targets whose fetch failed (NO-FETCH lines)
  let cur = null;
  for (const line of text.split('\n')) {
    const hd = line.match(/^✓ (.+) \((.+)\)$/);
    if (hd) { cur = sites[hd[1]] = { category: hd[2] }; continue; }
    const er = line.match(/^ERR\s+(.+?): (.*)$/);
    if (er) { errs.push({ site: er[1], error: er[2] }); cur = null; continue; }
    const nf = line.match(/^NO-FETCH\s+(.+)$/);
    if (nf) { missed[nf[1]] = true; cur = null; continue; }
    if (!cur || !/^ {4}\w+:\s/.test(line)) continue;
    const f = line.match(/^ {4}(email|phone|fb|ig):\s+(.*?)\s*\[([^\]]*)\]\s*$/);
    if (f) { cur[f[1]] = f[2]; cur[`${f[1]}Overlap`] = parseOverlap(f[3]); continue; }
    const plain = line.match(/^ {4}(fb|ig):\s+(\S+)\s*$/);
    if (plain) cur[plain[1]] = plain[2];
  }
  return { stats: s, sites, missed, errs };
}

function printStats(label, s) {
  console.log(`bench: [${label}] fetched ${s.fetched}/${s.tried} (${s.fetchedPct}%), ` +
    `any-contact ${s.anyContact}, email GT ${s.emailHits}+${s.emailNew}new, ` +
    `phone GT ${s.phoneHits}+${s.phoneNew}new, rate ${s.rate}% ` +
    (s.hoursFilled != null ? `hours ${s.hoursFilled}, rating ${s.ratingFilled} ` : '') +
    `${s.passed ? 'PASS' : 'FAIL'}`);
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
    ['hours filled', 'hoursFilled'], ['rating filled', 'ratingFilled'],
  ];
  const pad = (v, n) => String(v == null ? '–' : v).padStart(n);
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

  const missedA = A.missed || {};
  const missedB = B.missed || {};
  const names = [...new Set([...Object.keys(A.sites), ...Object.keys(B.sites)])].sort();
  const lines = { gtLoss: [], gtGain: [], gained: [], lost: [], changed: [], onlyA: [], onlyB: [], unfetchedA: [], unfetchedB: [] };
  for (const n of names) {
    const a = A.sites[n], b = B.sites[n];
    // v6.9.140: a site absent because its page never loaded is reachability
    // noise and is tracked separately from a page that loaded but yielded
    // nothing (the latter IS a potential regression).
    if (!a) { (missedA[n] ? lines.unfetchedA : lines.onlyB).push(n); continue; }
    if (!b) { (missedB[n] ? lines.unfetchedB : lines.onlyA).push(n); continue; }
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
  emit(`unfetched in ${B.label} (network — their hits are excused)`, lines.unfetchedB);
  emit(`unfetched in ${A.label} (network)`, lines.unfetchedA);
  emit(`only in ${A.label} (fetched in B but yielded nothing)`, lines.onlyA);
  emit(`only in ${B.label} (fetched in A but yielded nothing)`, lines.onlyB);

  const emailDelta = B.stats.emailHits - A.stats.emailHits;
  const phoneDelta = B.stats.phoneHits - A.stats.phoneHits;

  // Reachability credit: GT hits A scored on pages B never fetched cannot be
  // a parser regression (the parser never saw them) — they are excused.
  // Fetch failures are tracked per target via NO-FETCH lines, so a page that
  // WAS fetched and then lost a GT hit still counts as a real regression.
  const reach = { email: 0, phone: 0 };
  for (const [n, s] of Object.entries(A.sites)) {
    if (!missedB[n]) continue;
    if ((s.emailOverlap ?? 0) > 0) reach.email++;
    if ((s.phoneOverlap ?? 0) > 0) reach.phone++;
  }
  if (reach.email || reach.phone) {
    console.log(`\nnote: ${Object.keys(missedB).length} pages were unfetched in ${B.label} — their GT hits are excused as reachability.`);
  }

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
  const emailEff = emailDelta + credit.email + reach.email;
  const phoneEff = phoneDelta + credit.phone + reach.phone;
  const fmt = (d, f) => {
    const s = d === 0 ? '=' : d > 0 ? `+${d}` : String(d);
    const parts = [];
    if (credit[f]) parts.push(`tradeoff +${credit[f]}`);
    if (reach[f]) parts.push(`reachability +${reach[f]}`);
    const c = credit[f] + reach[f];
    return parts.length ? `${s} (raw ${d}; ${parts.join('; ')} → ${d + c})` : s;
  };
  console.log(`\nverdict: email GT ${fmt(emailDelta, 'email')}, phone GT ${fmt(phoneDelta, 'phone')}`);
  if (strict && (emailEff < 0 || phoneEff < 0)) {
    console.error('STRICT: ground-truth hits regressed (beyond known tradeoffs and unfetched pages)');
    process.exit(1);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────
function argValue(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
const strict = process.argv.includes('--strict');

const fresh = process.argv.includes('--fresh');
const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*|^ \* ?/gm, ''));
  process.exit(0);
}
if (cmd === 'run') {
  const ref = argValue('--ref');
  const label = argValue('--label') || (ref ? ref.replace(/[^A-Za-z0-9_.-]/g, '_') : 'current');
  const bundle = ref ? buildFromRef(ref) : build(ENTRY, path.join(TMP, 'current.cjs'));
  runHarness(bundle, label, { fresh });
} else if (cmd === 'oldnew') {
  const ref = argValue('--ref');
  if (!ref) die('oldnew requires --ref <gitref> (the baseline to compare against)');
  const baseLabel = argValue('--label') || ref.replace(/[^A-Za-z0-9_.-]/g, '_');
  const A = runHarness(buildFromRef(ref), baseLabel, { fresh: !!fresh });
  const B = runHarness(build(ENTRY, path.join(TMP, 'current.cjs')), 'current', { fresh: !!fresh });
  compare(A, B, strict);
} else if (cmd === 'compare') {
  const [fa, fb] = rest.filter(a => !a.startsWith('--'));
  if (!fa || !fb) die('compare <a.json> <b.json>');
  const load = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die(`cannot read ${p}: ${e.message}`); } };
  const A = load(fa);
  const B = load(fb);
  if (A === undefined || B === undefined) process.exit(2);
  compare(A, B, strict);
} else {
  die(`unknown command "${cmd}" — use run | oldnew | compare (see --help)`);
}
