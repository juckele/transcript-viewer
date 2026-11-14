#!/usr/bin/env node
// Estimates what the plan's limits are worth at API list prices, from the sampler's data (sample-usage.js).
//
// Each time a limit's percentage goes up by one, we add up the list-price cost of every logged API call since that
// window opened, on every computer that records a ledger. Cost against percentage is close to a straight line; its
// slope is the list-price value of 1% of the limit. Each window gets its own intercept, which absorbs usage the
// plan counts but these transcripts don't show (claude.ai, the phone, a computer without the sampler).
//
//   node sampler/analyze.js [--dir <data dir>] [--out <file>] [--quiet]
//
// The data dir is found the way install.sh picks it: --dir, CLAUDE_USAGE_DIR, ~/git/<repo name> when
// CLAUDE_USAGE_REPO is set, else ~/.local/share/claude-usage. The result goes to
// ~/.local/state/claude-usage-sampler/analysis.json (or CLAUDE_USAGE_STATE_DIR), where the viewer's Usage page
// shows it.
'use strict';
const fs = require('fs');
const path = require('path');
const { costOf, PRICING } = require('../lib/pricing');
const { analysisPath, defaultDataDir } = require('../lib/usage');

const MIN = 60e3, HOUR = 60 * MIN;
const MAX_BRACKET = 15 * MIN; // ignore a tick when the polls around it are further apart than this
const STALE = 2 * HOUR;       // a computer whose last sample is older than this is flagged
const WINDOW_HOURS = { session: 5, weekly: 168 };

function parseArgs(argv) {
  const o = { dir: null, out: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  return o;
}

function readJsonl(f) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* a line cut off mid-write */ }
  }
  return out;
}

// Every subfolder with sampler files is one computer.
function loadData(dir) {
  const hosts = [];
  const calls = new Map();
  const samples = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new Error(`can't read ${dir}: ${e.message}`); }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const hdir = path.join(dir, e.name);
    const files = fs.readdirSync(hdir);
    const sampleFiles = files.filter(f => /^samples-.*\.jsonl$/.test(f)).sort();
    if (!sampleFiles.length && !files.includes('ledger.jsonl')) continue;
    const h = { name: e.name, samples: 0, firstSample: null, lastSample: null, calls: 0, lastCall: null };
    for (const f of sampleFiles) for (const s of readJsonl(path.join(hdir, f))) {
      s.t = Date.parse(s.ts);
      if (!s.usage || !s.t) continue;
      samples.push(s);
      h.samples++;
      if (!h.firstSample || s.ts < h.firstSample) h.firstSample = s.ts;
      if (!h.lastSample || s.ts > h.lastSample) h.lastSample = s.ts;
    }
    for (const r of readJsonl(path.join(hdir, 'ledger.jsonl'))) {
      h.calls++;
      if (!h.lastCall || r.ts > h.lastCall) h.lastCall = r.ts;
      if (calls.has(r.id)) continue; // the same message can show up in two transcripts
      const k = costOf(r.model, r, r.speed);
      calls.set(r.id, { t: Date.parse(r.ts), model: r.model || '', cost: k ? k.cost : 0, priced: !!k });
    }
    hosts.push(h);
  }
  samples.sort((a, b) => a.t - b.t);
  const callList = [...calls.values()].filter(c => c.t).sort((a, b) => a.t - b.t);
  return { hosts, samples, calls: callList };
}

// The limits in one sample, keyed by kind and scope. Older responses only had five_hour / seven_day.
function limitsOf(s) {
  const u = s.usage;
  if (Array.isArray(u.limits)) {
    return u.limits.map(l => {
      const model = l.scope && l.scope.model && l.scope.model.display_name;
      const surface = l.scope && l.scope.surface;
      return { key: [l.kind, model, surface].filter(Boolean).join(':'), kind: l.kind, group: l.group, model, surface, pct: l.percent, resetsAt: l.resets_at };
    });
  }
  const out = [];
  if (u.five_hour) out.push({ key: 'session', kind: 'session', group: 'session', pct: u.five_hour.utilization, resetsAt: u.five_hour.resets_at });
  if (u.seven_day) out.push({ key: 'weekly_all', kind: 'weekly_all', group: 'weekly', pct: u.seven_day.utilization, resetsAt: u.seven_day.resets_at });
  return out;
}

function label(l) {
  if (l.kind === 'session') return '5-hour';
  if (l.kind === 'weekly_all') return 'Weekly, all models';
  return `Weekly, ${l.model || l.surface || l.kind}`;
}

// Prefix sums so the cost between two times is two binary searches.
function costIndex(calls, pred) {
  const ts = [], cum = [0];
  for (const c of calls) if (pred(c)) { ts.push(c.t); cum.push(cum[cum.length - 1] + c.cost); }
  const before = t => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; };
  return (a, b) => cum[before(b)] - cum[before(a)];
}

// Least squares with one slope and a separate intercept per window.
function fit(points) {
  const byWin = new Map();
  for (const p of points) { if (!byWin.has(p.window)) byWin.set(p.window, []); byWin.get(p.window).push(p); }
  let sxy = 0, sxx = 0, n = 0;
  const wins = [];
  for (const [w, ps] of byWin) {
    if (ps.length < 2) continue; // one point says nothing about the slope, and its intercept is just noise
    const mx = ps.reduce((s, p) => s + p.x, 0) / ps.length, my = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    for (const p of ps) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
    n += ps.length;
    wins.push({ window: w, ps, mx, my });
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  let ssr = 0;
  const windows = wins.map(({ window, ps, mx, my }) => {
    const intercept = my - slope * mx;
    for (const p of ps) ssr += (p.y - intercept - slope * p.x) ** 2;
    return { start: new Date(window).toISOString(), points: ps.length, fromPct: Math.min(...ps.map(p => p.x)), toPct: Math.max(...ps.map(p => p.x)), intercept };
  }).sort((a, b) => (a.start < b.start ? -1 : 1));
  const dof = n - wins.length - 1;
  const stderr = dof > 0 ? Math.sqrt(ssr / dof / sxx) : null;
  const meanIntercept = windows.reduce((s, w) => s + w.intercept * w.points, 0) / n;
  return { perPercent: slope, stderr, points: n, untrackedPerWindow: -meanIntercept, windows };
}

function analyze(data, now = Date.now()) {
  const { samples, calls } = data;
  const lastCall = calls.length ? calls[calls.length - 1].t : 0;
  const series = new Map(); // limit key -> { meta, ticks, last }
  for (const s of samples) {
    for (const l of limitsOf(s)) {
      if (l.pct == null) continue;
      let ser = series.get(l.key);
      if (!ser) series.set(l.key, ser = { meta: l, ticks: [], prev: null, last: null });
      const prev = ser.prev;
      const reset = l.resetsAt ? Date.parse(l.resetsAt) : null;
      const prevReset = prev && prev.resetsAt ? Date.parse(prev.resetsAt) : null;
      // Reset times jitter by a second or so between polls; a real change is a new window.
      // Each window keeps the first reset time seen for it, so the jitter can't split it in two.
      const sameWindow = reset && prevReset && Math.abs(reset - prevReset) < 2 * MIN;
      if (reset && !sameWindow) ser.win = reset;
      if (prev && reset && l.pct > prev.pct && (sameWindow || !prevReset)) {
        ser.ticks.push({ lo: prev.t, hi: s.t, from: prev.pct, to: l.pct, reset: ser.win });
      }
      ser.prev = { pct: l.pct, resetsAt: l.resetsAt, t: s.t };
      ser.last = { pct: l.pct, resetsAt: l.resetsAt, ts: s.ts };
    }
  }

  const limits = [];
  for (const [key, ser] of series) {
    const m = ser.meta;
    const hours = WINDOW_HOURS[m.group] || (m.kind === 'session' ? 5 : m.kind.startsWith('weekly') ? 168 : null);
    const out = { key, label: label(m), windowHours: hours, current: ser.last, ticks: ser.ticks.length, fit: null, note: null };
    limits.push(out);
    if (!hours) { out.note = 'unknown window length'; continue; }
    // A model-scoped limit counts only that model's calls. A surface scope can't be matched to the ledger.
    if (m.surface) { out.note = `scoped to ${m.surface}, which the ledger can't separate`; continue; }
    const name = m.model && m.model.toLowerCase();
    const cost = costIndex(calls, name ? c => c.model.toLowerCase().includes(name) : () => true);
    const winMs = hours * HOUR;
    const points = [];
    for (const t of ser.ticks) {
      if (t.to - t.from !== 1 || t.hi - t.lo > MAX_BRACKET) continue;
      if (t.hi > lastCall) continue; // the ledger hasn't caught up to this tick yet
      const start = t.reset - winMs;
      const y = (cost(start, t.lo) + cost(start, t.hi)) / 2;
      points.push({ window: start, x: t.to, y, at: new Date(t.hi).toISOString() });
    }
    out.fit = fit(points);
    if (out.fit) {
      out.fit.fullLimit = out.fit.perPercent * 100;
      out.fit.recent = points.slice(-200).map(p => ({ at: p.at, pct: p.x, cost: +p.y.toFixed(2), window: new Date(p.window).toISOString() }));
    }
    if (ser.last && ser.last.resetsAt) {
      const end = Date.parse(ser.last.resetsAt);
      out.current.windowStart = new Date(end - winMs).toISOString();
      out.current.costSoFar = cost(end - winMs, Math.min(now, end));
    }
    if (!out.fit) out.note = 'not enough ticks yet';
  }
  const order = ['session', 'weekly_all'];
  limits.sort((a, b) => ((order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99)) || a.key.localeCompare(b.key));

  const weekly = limits.find(l => l.key === 'weekly_all');
  const perMonth = weekly && weekly.fit ? weekly.fit.fullLimit * 365.25 / 7 / 12 : null;
  const hosts = data.hosts.map(h => ({ ...h, stale: !h.lastSample || now - Date.parse(h.lastSample) > STALE }));
  return {
    generatedAt: new Date(now).toISOString(),
    samples: samples.length,
    calls: calls.length,
    unpricedCalls: calls.filter(c => !c.priced).length,
    hosts,
    limits,
    monthly: { fromWeekly: perMonth, estimate: PRICING.subscription ? PRICING.subscription.apiCreditsPerMonth : null },
  };
}

function usd(v) { return v == null ? '-' : '$' + (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2)); }

function report(a, dir, out) {
  const lines = [`Data: ${dir}  (${a.samples} samples, ${a.calls} API calls${a.unpricedCalls ? `, ${a.unpricedCalls} without a price` : ''})`];
  for (const h of a.hosts) lines.push(`  ${h.name}: ${h.samples} samples, last ${h.lastSample || 'never'}${h.stale ? '  (stale)' : ''}; ${h.calls} ledger rows, last call ${h.lastCall || 'never'}`);
  lines.push('');
  for (const l of a.limits) {
    const f = l.fit;
    const cur = l.current ? `now ${l.current.pct}%${l.current.costSoFar != null ? `, ${usd(l.current.costSoFar)} so far` : ''}` : '';
    if (!f) { lines.push(`${l.label}: ${l.note}. ${cur}`); continue; }
    lines.push(`${l.label}: ${usd(f.perPercent)} per 1%${f.stderr != null ? ` (±${usd(f.stderr)})` : ''}, so the full limit is about ${usd(f.fullLimit)}. ` +
      `${f.points} ticks over ${f.windows.length} window${f.windows.length === 1 ? '' : 's'}; ${usd(f.untrackedPerWindow)} per window not in the ledger. ${cur}`);
  }
  if (a.monthly.fromWeekly) lines.push('', `Weekly limit per month: about ${usd(a.monthly.fromWeekly)} at list price (pricing.json estimates ${usd(a.monthly.estimate)}).`);
  lines.push('', `Wrote ${out}`);
  console.log(lines.join('\n'));
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = o.dir || defaultDataDir();
  const out = o.out || analysisPath();
  const a = analyze(loadData(dir));
  a.dataDir = dir;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(a, null, 1) + '\n');
  fs.renameSync(tmp, out);
  if (!o.quiet) report(a, dir, out);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { analyze, loadData, fit };
