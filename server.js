#!/usr/bin/env node
// Claude Code transcript viewer: watches ~/.claude/projects and serves live views.
// Zero dependencies. Run: node server.js  (then open http://127.0.0.1:4777)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const PORT = Number(process.env.PORT) || 4777;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const MAX_RESULT_CHARS = 20000;

// Only answer requests addressed to this server by a name we expect. Otherwise a web page could point its own
// domain at 127.0.0.1 (DNS rebinding) and read the transcripts. ALLOWED_HOSTS adds names, comma-separated.
const ALLOWED_HOSTS = new Set(
  ['localhost', '127.0.0.1', '[::1]', HOST, ...(process.env.ALLOWED_HOSTS || '').split(',')]
    .map(h => h.trim().toLowerCase())
    .filter(h => h && !['0.0.0.0', '::', '[::]'].includes(h)));
function hostAllowed(header) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec((header || '').toLowerCase());
  return !!m && ALLOWED_HOSTS.has(m[1]) && Number(m[2] || 80) === PORT;
}

// ---------- pricing ----------
const PRICING = JSON.parse(fs.readFileSync(path.join(__dirname, 'pricing.json'), 'utf8'));
function priceFor(model) {
  if (!model) return null;
  let best = null;
  for (const [id, p] of Object.entries(PRICING.models)) {
    if (model === id || model.startsWith(id + '-')) {
      if (!best || id.length > best.id.length) best = { id, ...p };
    }
  }
  return best;
}
// Returns { cost, assumed } or null when the model has no known price.
function costOf(model, u, speed) {
  const p = priceFor(model);
  if (!p) return null;
  let input = p.input, output = p.output, read = p.cacheRead;
  const totalIn = u.in + u.cr + u.cw5 + u.cw1h;
  if (p.longContext && totalIn > p.longContext.above) {
    input = p.longContext.input; output = p.longContext.output; read = p.longContext.cacheRead;
  }
  const m = speed === 'fast' ? (p.fastMultiplier || 2) : 1;
  const parts = {
    in: u.in * input * m / 1e6,
    cw: (u.cw5 * input * PRICING.cacheWrite5mMultiplier + u.cw1h * input * PRICING.cacheWrite1hMultiplier) * m / 1e6,
    cr: u.cr * read * m / 1e6,
    out: u.out * output * m / 1e6,
  };
  return { cost: parts.in + parts.cw + parts.cr + parts.out, parts, assumed: !!p.assumed };
}
const { normUsage } = require('./lib/usage');

// ---------- file discovery ----------
// Main transcript: ROOT/<project>/<session>.jsonl
// Subagent:        ROOT/<project>/<session>/subagents/agent-<id>.jsonl
function classify(abs) {
  const rel = path.relative(ROOT, abs);
  const parts = rel.split(path.sep);
  if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
    return { kind: 'main', project: parts[0], session: parts[1].slice(0, -6) };
  }
  if (parts.length === 4 && parts[2] === 'subagents' && /^agent-.*\.jsonl$/.test(parts[3])) {
    return { kind: 'sub', project: parts[0], session: parts[1], agent: parts[3].slice(6, -6) };
  }
  return null;
}
function listFiles() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(ROOT, p.name);
    let ents = [];
    try { ents = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(pdir, e.name));
      else if (e.isDirectory()) {
        const sdir = path.join(pdir, e.name, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(sdir); } catch { continue; }
        for (const s of subs) if (/^agent-.*\.jsonl$/.test(s)) out.push(path.join(sdir, s));
      }
    }
  }
  return out;
}

// ---------- incremental summary index ----------
// Per file we keep a byte offset and only parse newly appended lines.
const files = new Map(); // abs -> state
function newState(info) {
  return {
    ...info, offset: 0, size: 0, mtimeMs: 0, partial: '',
    calls: new Map(), // message.id -> { ts, model, speed, u }
    customTitle: null, agentName: null, firstPrompt: null, lastPrompt: null,
    cwd: null, gitBranch: null, firstTs: null, lastTs: null, prompts: 0,
  };
}
function isRealPrompt(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain && !d.agentId) return false;
  const c = d.message && d.message.content;
  if (typeof c === 'string') return !c.startsWith('<');
  if (Array.isArray(c)) return c.some(b => b.type === 'text' && b.text && !b.text.startsWith('<'));
  return false;
}
function promptText(d) {
  const c = d.message.content;
  if (typeof c === 'string') return c;
  return c.filter(b => b.type === 'text').map(b => b.text).join('\n');
}
function ingestLine(st, line) {
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (d.timestamp) {
    if (!st.firstTs || d.timestamp < st.firstTs) st.firstTs = d.timestamp;
    if (!st.lastTs || d.timestamp > st.lastTs) st.lastTs = d.timestamp;
  }
  if (d.cwd && !st.cwd) st.cwd = d.cwd;
  if (d.gitBranch) st.gitBranch = d.gitBranch;
  switch (d.type) {
    case 'custom-title': st.customTitle = d.customTitle; break;
    case 'agent-name': st.agentName = d.agentName; break;
    case 'user':
      if (isRealPrompt(d)) {
        st.prompts++;
        const t = promptText(d);
        if (!st.firstPrompt) st.firstPrompt = t.slice(0, 300);
        st.lastPrompt = t.slice(0, 300);
      }
      break;
    case 'assistant': {
      const m = d.message;
      if (!m || !m.id || !m.usage || m.model === '<synthetic>') break;
      // One API response is split across several lines that repeat the same usage; key by id.
      st.calls.set(m.id, { ts: d.timestamp, model: m.model, speed: m.usage.speed, u: normUsage(m.usage) });
      break;
    }
  }
}
function refreshFile(abs) {
  let stat;
  try { stat = fs.statSync(abs); } catch { return files.delete(abs); }
  let st = files.get(abs);
  if (!st) {
    const info = classify(abs);
    if (!info) return false;
    st = newState(info);
    files.set(abs, st);
  }
  if (stat.size === st.size && stat.mtimeMs === st.mtimeMs) return false;
  if (stat.size < st.offset) { // truncated or rewritten: start over
    const info = { kind: st.kind, project: st.project, session: st.session, agent: st.agent };
    st = newState(info);
    files.set(abs, st);
  }
  const fd = fs.openSync(abs, 'r');
  try {
    const len = stat.size - st.offset;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.offset);
      const text = st.partial + buf.toString('utf8');
      const lines = text.split('\n');
      st.partial = lines.pop();
      for (const l of lines) if (l.trim()) ingestLine(st, l);
      st.offset = stat.size;
    }
  } finally { fs.closeSync(fd); }
  st.size = stat.size;
  st.mtimeMs = stat.mtimeMs;
  return true;
}

function emptyTotals() {
  return { in: 0, out: 0, cr: 0, cw5: 0, cw1h: 0, think: 0, calls: 0, cost: 0, costParts: { in: 0, cw: 0, cr: 0, out: 0 }, unpriced: 0, assumed: false };
}
function addCall(t, c) {
  t.in += c.u.in; t.out += c.u.out; t.cr += c.u.cr; t.cw5 += c.u.cw5; t.cw1h += c.u.cw1h; t.think += c.u.think; t.calls++;
  const k = costOf(c.model, c.u, c.speed);
  if (k) {
    t.cost += k.cost;
    for (const x in k.parts) t.costParts[x] += k.parts[x];
    if (k.assumed) t.assumed = true;
  } else t.unpriced++;
}

function sessionKey(project, session) { return project + '/' + session; }
function sessionSummaries() {
  const byKey = new Map();
  for (const st of files.values()) {
    const key = sessionKey(st.project, st.session);
    let s = byKey.get(key);
    if (!s) {
      s = { key, project: st.project, session: st.session, title: null, firstPrompt: null, lastPrompt: null,
        cwd: null, gitBranch: null, firstTs: null, lastTs: null, prompts: 0, subagents: 0, size: 0,
        main: emptyTotals(), sub: emptyTotals(), models: {} };
      byKey.set(key, s);
    }
    s.size += st.size;
    if (st.lastTs && (!s.lastTs || st.lastTs > s.lastTs)) s.lastTs = st.lastTs;
    if (st.firstTs && (!s.firstTs || st.firstTs < s.firstTs)) s.firstTs = st.firstTs;
    const tot = st.kind === 'main' ? s.main : s.sub;
    for (const c of st.calls.values()) { addCall(tot, c); s.models[c.model] = (s.models[c.model] || 0) + 1; }
    if (st.kind === 'main') {
      s.title = st.customTitle || st.agentName || null;
      s.firstPrompt = st.firstPrompt; s.lastPrompt = st.lastPrompt;
      s.cwd = st.cwd; s.gitBranch = st.gitBranch; s.prompts = st.prompts;
    } else s.subagents++;
  }
  return [...byKey.values()].filter(s => s.lastTs).sort((a, b) => (b.lastTs > a.lastTs ? 1 : -1));
}

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Totals for one local day across every transcript (calls are bucketed by their own timestamp, so a session
// that started yesterday only counts today's calls).
function dayTotals(day) {
  const t = emptyTotals();
  for (const st of files.values()) for (const c of st.calls.values()) if (c.ts && localDay(c.ts) === day) addCall(t, c);
  return t;
}
function usageDaily() {
  const days = new Map();
  const models = {};
  for (const st of files.values()) {
    for (const c of st.calls.values()) {
      if (!c.ts) continue;
      const day = localDay(c.ts);
      if (!days.has(day)) days.set(day, { day, ...emptyTotals(), byModel: {} });
      const t = days.get(day);
      addCall(t, c);
      const k = costOf(c.model, c.u, c.speed);
      t.byModel[c.model] = (t.byModel[c.model] || 0) + (k ? k.cost : 0);
      if (!models[c.model]) models[c.model] = emptyTotals();
      addCall(models[c.model], c);
    }
  }
  const out = { days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)), models, window: null };
  // Optional: totals inside the current weekly limit window, anchored on a known reset time.
  const anchor = process.env.WEEKLY_RESET_AT && Date.parse(process.env.WEEKLY_RESET_AT);
  if (anchor) {
    const week = 7 * 24 * 3600e3;
    const now = Date.now();
    const end = anchor + Math.ceil((now - anchor) / week) * week;
    const start = end - week;
    const t = emptyTotals();
    for (const st of files.values()) for (const c of st.calls.values()) {
      const ms = Date.parse(c.ts);
      if (ms >= start && ms < end) addCall(t, c);
    }
    out.window = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...t };
  }
  return out;
}

// ---------- full parse for the reader ----------
function readJsonl(abs) {
  const rows = [];
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return rows; }
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch {} }
  return rows;
}
function clip(s) {
  if (typeof s !== 'string') s = JSON.stringify(s, null, 2);
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `\n… [${s.length - MAX_RESULT_CHARS} more characters]` : s;
}
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : JSON.stringify(b)).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}
// Turns a transcript into display items: user prompts, assistant messages (blocks merged
// across lines), tool results keyed by tool_use id, and compaction markers.
function buildConversation(rows) {
  const items = [];
  const byMsgId = new Map();
  const results = {};
  for (const d of rows) {
    if (d.type === 'user') {
      const c = d.message && d.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result') results[b.tool_use_id] = { text: clip(resultText(b.content)), isError: !!b.is_error };
        }
      }
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
      const images = Array.isArray(c) ? c.filter(b => b.type === 'image').length : 0;
      if (text || images) {
        const meta = !!d.isMeta || text.startsWith('<');
        items.push({ kind: 'user', ts: d.timestamp, uuid: d.uuid, text: clip(text), images, meta });
      }
    } else if (d.type === 'assistant') {
      const m = d.message;
      if (!m) continue;
      let it = m.id && byMsgId.get(m.id);
      if (!it) {
        it = { kind: 'assistant', ts: d.timestamp, id: m.id, model: m.model, blocks: [], usage: null, cost: null, stop: null };
        if (m.usage && m.model !== '<synthetic>') {
          it.usage = normUsage(m.usage);
          const k = costOf(m.model, it.usage, m.usage.speed);
          it.cost = k && k.cost; it.assumed = k && k.assumed; it.speed = m.usage.speed;
        }
        if (m.id) byMsgId.set(m.id, it);
        items.push(it);
      }
      it.stop = m.stop_reason || it.stop;
      for (const b of m.content || []) {
        if (b.type === 'text') it.blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'thinking') it.blocks.push({ type: 'thinking', text: b.thinking || '' });
        else if (b.type === 'redacted_thinking') it.blocks.push({ type: 'thinking', text: '' });
        else if (b.type === 'tool_use' || b.type === 'server_tool_use') it.blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
    } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
      items.push({ kind: 'marker', ts: d.timestamp, text: 'Context compacted' });
    }
  }
  return { items, results };
}
function sessionDetail(project, session) {
  if (!/^[^/\\]+$/.test(project) || !/^[\w-]+$/.test(session)) return null;
  const mainPath = path.join(ROOT, project, session + '.jsonl');
  if (!fs.existsSync(mainPath)) return null;
  const main = buildConversation(readJsonl(mainPath));
  const subagents = [];
  const sdir = path.join(ROOT, project, session, 'subagents');
  let subs = [];
  try { subs = fs.readdirSync(sdir).filter(f => /^agent-.*\.jsonl$/.test(f)); } catch {}
  for (const f of subs) {
    const agentId = f.slice(6, -6);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(sdir, `agent-${agentId}.meta.json`), 'utf8')); } catch {}
    subagents.push({ agentId, meta, ...buildConversation(readJsonl(path.join(sdir, f))) });
  }
  const summary = sessionSummaries().find(s => s.key === sessionKey(project, session)) || null;
  return { summary, ...main, subagents };
}

// ---------- live updates ----------
const clients = new Set();
function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) res.write(msg);
}
let pending = new Set();
let timer = null;
function queue(abs) {
  pending.add(abs);
  if (!timer) timer = setTimeout(flush, 250);
}
function flush() {
  timer = null;
  const changed = new Set();
  for (const abs of pending) {
    if (refreshFile(abs)) {
      const st = files.get(abs);
      if (st) changed.add(sessionKey(st.project, st.session));
    }
  }
  pending = new Set();
  if (changed.size) broadcast({ type: 'changed', sessions: [...changed] });
}
function fullScan() {
  const seen = new Set(listFiles());
  for (const abs of seen) queue(abs);
  for (const abs of [...files.keys()]) if (!seen.has(abs)) { files.delete(abs); broadcast({ type: 'changed', sessions: [] }); }
}
function startWatching() {
  try {
    fs.watch(ROOT, { recursive: true }, (_evt, name) => {
      if (!name || !name.endsWith('.jsonl')) return;
      queue(path.join(ROOT, name));
    });
  } catch (e) {
    console.warn('fs.watch unavailable, relying on polling:', e.message);
  }
  setInterval(fullScan, 5000); // safety net for missed events and new folders
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function sendJson(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const server = http.createServer((req, res) => {
  if (!hostAllowed(req.headers.host)) { res.writeHead(403); return res.end('forbidden host\n'); }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (p === '/api/sessions') return sendJson(res, { root: ROOT, sessions: sessionSummaries(), today: dayTotals(localDay(Date.now())) });
  if (p === '/api/usage') return sendJson(res, usageDaily());
  if (p === '/api/pricing') return sendJson(res, PRICING);
  if (p === '/api/session') {
    const d = sessionDetail(url.searchParams.get('p') || '', url.searchParams.get('s') || '');
    if (!d) { res.writeHead(404); return res.end('not found'); }
    return sendJson(res, d);
  }
  const file = p === '/' ? 'index.html' : p.slice(1);
  const abs = path.join(PUBLIC, file);
  if (!abs.startsWith(PUBLIC + path.sep) || !fs.existsSync(abs)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(abs).pipe(res);
});

const t0 = Date.now();
for (const abs of listFiles()) refreshFile(abs);
console.log(`Indexed ${files.size} transcript files from ${ROOT} in ${Date.now() - t0} ms`);
startWatching();
server.listen(PORT, HOST, () => console.log(`Transcript viewer: http://${HOST}:${PORT}`));
