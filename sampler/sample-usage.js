#!/usr/bin/env node
// Records the plan's 5-hour and weekly usage percentages, and a token ledger of this computer's transcripts,
// so they can be matched against list-price cost. Run it every minute (sampler/install.sh sets that up).
// Zero dependencies, Node 18+. One run does at most one poll and exits.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { normUsage } = require('../lib/usage');

const MIN = 60e3;
const ACTIVE_WINDOW = 15 * MIN;  // a transcript written this recently means Claude is in use: poll every run
const IDLE_INTERVAL = 15 * MIN;  // otherwise poll this often
const HEARTBEAT = 60 * MIN;      // write a sample at least this often even when nothing changed
const LEDGER_INTERVAL = 10 * MIN;
const REFRESH_MARGIN = 10 * MIN; // refresh the login token when it expires sooner than this

const HOME = os.homedir();
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS = process.env.CLAUDE_PROJECTS_DIR || path.join(CONFIG_DIR, 'projects');
const HOSTNAME = (process.env.CLAUDE_USAGE_HOST || os.hostname().split('.')[0]).toLowerCase();
const STATE_DIR = process.env.CLAUDE_USAGE_STATE_DIR || path.join(HOME, '.local', 'state', 'claude-usage-sampler');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// Each computer writes only its own folder here. When this is a git clone (install.sh --repo), the sampler also
// commits and pushes it; other computers only touch their own folders, so pushes never conflict.
const DATA_DIR = process.env.CLAUDE_USAGE_DIR || path.join(HOME, '.local', 'share', 'claude-usage');
const OUT_DIR = path.join(DATA_DIR, HOSTNAME);
const SYNC_INTERVAL = 30 * MIN;  // commit and push this often when something changed
const SYNC_RETRY = 5 * MIN;      // after a failed push

function log(...a) { console.error(new Date().toISOString(), ...a); }
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function writeAtomic(f, text) {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
}

// ---------- transcripts ----------
// Main transcripts are <project>/<session>.jsonl; subagents are <project>/<session>/subagents/agent-*.jsonl.
function transcriptFiles() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(PROJECTS, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(PROJECTS, p.name);
    let ents = [];
    try { ents = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push({ abs: path.join(pdir, e.name), project: p.name, session: e.name.slice(0, -6), agent: null });
      } else if (e.isDirectory()) {
        const sdir = path.join(pdir, e.name, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(sdir); } catch { continue; }
        for (const s of subs) {
          if (/^agent-.*\.jsonl$/.test(s)) out.push({ abs: path.join(sdir, s), project: p.name, session: e.name, agent: s.slice(6, -6) });
        }
      }
    }
  }
  for (const f of out) { try { f.mtimeMs = fs.statSync(f.abs).mtimeMs; } catch { f.mtimeMs = 0; } }
  return out;
}

// One row per API response (message.id), tokens only. Cost is worked out later from pricing.json.
function updateLedger(files, sinceMs) {
  const ledgerFile = path.join(OUT_DIR, 'ledger.jsonl');
  const rows = new Map();
  if (sinceMs > 0) {
    let text = '';
    try { text = fs.readFileSync(ledgerFile, 'utf8'); } catch {}
    for (const l of text.split('\n')) { if (!l) continue; try { const r = JSON.parse(l); rows.set(r.id, r); } catch {} }
  }
  let parsed = 0;
  for (const f of files) {
    if (f.mtimeMs < sinceMs) continue;
    parsed++;
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(l); } catch { continue; }
      const m = d.type === 'assistant' && d.message;
      if (!m || !m.id || !m.usage || m.model === '<synthetic>') continue;
      rows.set(m.id, {
        id: m.id, ts: d.timestamp, host: HOSTNAME, model: m.model, speed: m.usage.speed || null,
        ...normUsage(m.usage), project: f.project, session: f.session, agent: f.agent,
      });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  writeAtomic(ledgerFile, sorted.map(r => JSON.stringify(r)).join('\n') + (sorted.length ? '\n' : ''));
  return { parsed, rows: sorted.length };
}

// ---------- login token ----------
function readCredentials() {
  let raw = null;
  if (process.platform === 'darwin') {
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' });
    if (r.status === 0) raw = r.stdout.trim();
  }
  if (!raw) { try { raw = fs.readFileSync(path.join(CONFIG_DIR, '.credentials.json'), 'utf8'); } catch {} }
  if (!raw) return null;
  try { return JSON.parse(raw).claudeAiOauth || null; } catch { return null; }
}
// `claude auth status` refreshes an expired login token with Claude Code's own locking, so we never handle the
// refresh token ourselves. It makes no model calls.
function refreshCredentials() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(k)) delete env[k];
  const r = spawnSync(process.env.CLAUDE_BIN || 'claude', ['auth', 'status'], { env, encoding: 'utf8', timeout: 60e3, cwd: HOME });
  if (r.status !== 0) log('claude auth status failed:', r.error ? r.error.message : (r.stderr || '').trim().slice(0, 300));
  return readCredentials();
}
async function fetchUsage(token) {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'transcript-viewer-usage-sampler' },
    signal: AbortSignal.timeout(20e3),
  });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// What counts as a change: any limit's percent or reset time (rounded to the minute; the API jitters the seconds).
function sampleKey(u) {
  const minute = t => (t ? Math.round(Date.parse(t) / MIN) : null);
  const win = w => (w ? [w.utilization, minute(w.resets_at)] : null);
  const limits = (u.limits || []).map(l => [l.kind, l.scope, l.percent, minute(l.resets_at)]);
  return JSON.stringify([win(u.five_hour), win(u.seven_day), win(u.seven_day_opus), win(u.seven_day_sonnet), limits]);
}

async function main() {
  const now = Date.now();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = readJson(STATE_FILE, {});
  const force = process.argv.includes('--now');

  const files = transcriptFiles();
  const newest = files.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
  const active = now - newest < ACTIVE_WINDOW;

  // Ledger: re-read only transcripts written since the last pass (with a minute's overlap).
  if (force || !state.ledgerMs || (now - state.ledgerMs >= LEDGER_INTERVAL && newest > state.ledgerMs - MIN)) {
    const since = state.ledgerMs ? state.ledgerMs - MIN : 0;
    const r = updateLedger(files, since);
    state.ledgerMs = now;
    if (force) log(`ledger: parsed ${r.parsed} files, ${r.rows} rows`);
  }

  try {
    if (force || active || !state.lastPollMs || now - state.lastPollMs >= IDLE_INTERVAL) await poll(state, now, active, force);
  } finally {
    try { sync(state, now, force); } catch (e) { log('sync error:', e.message); }
    writeAtomic(STATE_FILE, JSON.stringify(state));
  }
}

// ---------- push to the data repo ----------
function git(args) {
  const r = spawnSync('git', args, {
    cwd: DATA_DIR, encoding: 'utf8', timeout: 120e3,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GCM_INTERACTIVE: 'never' },
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || (r.error && r.error.message) || '').trim() };
}
function sync(state, now, force) {
  if (!fs.existsSync(path.join(DATA_DIR, '.git'))) return;
  const due = force || state.unpushed
    ? now - (state.syncTryMs || 0) >= SYNC_RETRY
    : now - (state.syncMs || 0) >= SYNC_INTERVAL;
  if (!due && !force) return;
  if (git(['status', '--porcelain', '--', HOSTNAME]).out) {
    git(['add', '--', HOSTNAME]);
    const c = git(['commit', '-q', '-m', `${HOSTNAME}: usage data ${new Date(now).toISOString().slice(0, 16)}Z`, '--', HOSTNAME]);
    if (!c.ok) throw new Error(`commit failed: ${c.err.slice(0, 300)}`);
    state.unpushed = true;
  }
  state.syncMs = now;
  if (!state.unpushed) return;
  state.syncTryMs = now;
  // Other computers only touch their own folders, so a rebase onto their commits never conflicts.
  if (git(['fetch', '-q', 'origin']).ok && git(['rev-parse', '-q', '--verify', 'origin/main']).ok) {
    const r = git(['rebase', '-q', 'origin/main']);
    if (!r.ok) { git(['rebase', '--abort']); throw new Error(`rebase failed: ${r.err.slice(0, 300)}`); }
  }
  const p = git(['push', '-q', 'origin', 'HEAD:main']);
  if (!p.ok) throw new Error(`push failed: ${p.err.slice(0, 300)}`);
  state.unpushed = false;
  if (force) log('pushed to', DATA_DIR);
}

async function poll(state, now, active, force) {
  {
    let creds = readCredentials();
    if (!creds) throw new Error('no Claude login found');
    if (!creds.expiresAt || creds.expiresAt - now < REFRESH_MARGIN) creds = refreshCredentials();
    let usage;
    try {
      usage = await fetchUsage(creds.accessToken);
    } catch (e) {
      if (e.status !== 401) throw e;
      creds = refreshCredentials();
      usage = await fetchUsage(creds.accessToken);
    }
    const key = sampleKey(usage);
    const reason = !state.lastKey ? 'first' : key !== state.lastKey ? 'change' : now - (state.lastWriteMs || 0) >= HEARTBEAT ? 'heartbeat' : null;
    if (reason) {
      const month = new Date(now).toISOString().slice(0, 7);
      // prevPollTs is the last poll that still saw the old values, so a change happened between it and ts.
      const row = { ts: new Date(now).toISOString(), prevPollTs: state.lastPollMs ? new Date(state.lastPollMs).toISOString() : null,
        host: HOSTNAME, reason, active, usage };
      fs.appendFileSync(path.join(OUT_DIR, `samples-${month}.jsonl`), JSON.stringify(row) + '\n');
      state.lastWriteMs = now;
      state.lastKey = key;
      if (force) log(`sample (${reason}): 5h ${usage.five_hour && usage.five_hour.utilization}%, 7d ${usage.seven_day && usage.seven_day.utilization}%`);
    }
    state.lastPollMs = now;
  }
}

main().catch(e => { log('error:', e.message); process.exit(1); });
