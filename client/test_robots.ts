// v6.9.157 unit tests: robots.txt gate for the crawl lanes
// Run: npm test (tsx test_robots.ts)
import { parseRobotsForAgent, robotsDisallows } from './src/clientEngine.js';

declare const process: { exit: (code: number) => void };

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

// ── parseRobotsForAgent ──────────────────────────────────────────

// T1: plain "*" group with disallow paths
const t1 = parseRobotsForAgent('User-agent: *\nDisallow: /private\nDisallow: /tmp\n');
eq('parse: star group disallows', t1, { paths: ['/private', '/tmp'], delay: 0 });

// T2: empty / unparsable → null (default-allow)
eq('parse: empty body → null', parseRobotsForAgent(''), null);
eq('parse: whitespace → null', parseRobotsForAgent('   \n  '), null);
eq('parse: no groups → null', parseRobotsForAgent('Sitemap: https://x.ge/s.xml'), null);

// T3: agent-specific group overrides "*"
const t3 = parseRobotsForAgent(
  'User-agent: *\nDisallow: /\n\nUser-agent: BlueOcean\nDisallow: /filtered\nCrawl-delay: 2\n');
eq('parse: named agent wins + delay', t3, { paths: ['/filtered'], delay: 2 });

// T4: unknown agent falls back to "*"
const t4 = parseRobotsForAgent('User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /all\n');
eq('parse: fallback to star', t4, { paths: ['/all'], delay: 0 });

// T5: crawl-delay caps at 10s — a site demanding 60s must not freeze a scan
const t5 = parseRobotsForAgent('User-agent: *\nCrawl-delay: 60\n');
eq('parse: delay capped at 10', t5?.delay ?? -1, 10);

// T6: comments and blank lines ignored
const t6 = parseRobotsForAgent('# hello\nUser-agent: * # star\nDisallow: /x # blocked\n');
eq('parse: comments stripped', t6, { paths: ['/x'], delay: 0 });

// ── robotsDisallows ──────────────────────────────────────────────

// T7: prefix matching
eq('match: exact prefix', robotsDisallows({ paths: ['/private'] }, '/private/page'), true);
eq('match: exact path', robotsDisallows({ paths: ['/private'] }, '/private'), true);
eq('match: sibling not blocked', robotsDisallows({ paths: ['/private'] }, '/privateering'), true);
// NOTE: robots.txt prefix semantics — '/private' genuinely blocks '/privateering'
eq('match: slash-anchored ok', robotsDisallows({ paths: ['/private/'] }, '/privateering'), false);
eq('match: no match', robotsDisallows({ paths: ['/a'] }, '/b'), false);

// T8: "/" alone disallows everything
eq('match: root disallows all', robotsDisallows({ paths: ['/'] }, '/anything'), true);

// T9: null / empty rules never disallow
eq('match: null rules', robotsDisallows(null, '/x'), false);
eq('match: empty paths', robotsDisallows({ paths: [] }, '/x'), false);

// T10: default-allow — absent robots file means crawl proceeds
eq('match: empty path never disallowed', robotsDisallows({ paths: [] }, '/'), false);

console.log(`\n${pass}/${pass + fail} tests pass`);
if (fail > 0) process.exit(1);
