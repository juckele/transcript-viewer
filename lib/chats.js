'use strict';
// claude.ai chat exports. claude.ai's data export (Settings → Privacy → Export data) emails a manifest of zips;
// conversations-000.zip holds one conversations.json with every chat in that account's organization. Unzip
// each export anywhere under a CLAUDE_CHAT_EXPORTS folder.
//
// The export has the messages, their content blocks and timestamps, but no model names or token counts, so
// chats have no cost.
const fs = require('fs');
const path = require('path');
const { clip, resultText } = require('./text');

const MAX_DEPTH = 4;

// Every conversations.json under root, up to MAX_DEPTH folders down.
function findExports(root) {
  const out = [];
  (function walk(dir, depth) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === 'conversations.json') out.push(p);
      else if (e.isDirectory() && depth < MAX_DEPTH && !e.name.startsWith('.')) walk(p, depth + 1);
    }
  })(root, 0);
  return out;
}

function readExport(abs) {
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  return Array.isArray(data) ? data : [];
}

// Export timestamps have microseconds; Claude Code's have milliseconds. Normalize so they sort as strings.
function iso(ts) {
  const ms = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Editing a prompt or retrying a reply starts a branch: messages point at their parent. Show the branch that
// ends at the newest message, as claude.ai does when the chat is reopened.
function mainBranch(msgs) {
  const byId = new Map(msgs.map(m => [m.uuid, m]));
  const parents = new Set(msgs.map(m => m.parent_message_uuid));
  const leaves = msgs.filter(m => !parents.has(m.uuid));
  if (!leaves.length) return msgs;
  const leaf = leaves.reduce((a, b) => ((b.created_at || '') > (a.created_at || '') ? b : a));
  const out = [];
  const seen = new Set();
  for (let m = leaf; m && !seen.has(m.uuid); m = byId.get(m.parent_message_uuid)) { seen.add(m.uuid); out.push(m); }
  return out.reverse();
}

function blocksOf(m) {
  if (Array.isArray(m.content) && m.content.length) return m.content;
  return m.text ? [{ type: 'text', text: m.text }] : [];
}
const textOf = blocks => blocks.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
const isPrompt = m => m.sender === 'human' && (textOf(blocksOf(m)).trim() || (m.attachments || []).length ||
  blocksOf(m).some(b => b.type === 'image' || b.type === 'document'));

// One row for the sessions list.
function summarize(c) {
  const all = c.chat_messages || [];
  const msgs = mainBranch(all);
  const prompts = msgs.filter(isPrompt);
  const first = prompts[0], last = prompts[prompts.length - 1];
  let toolCalls = 0;
  for (const m of msgs) for (const b of blocksOf(m)) if (b.type === 'tool_use') toolCalls++;
  const lastMsg = msgs[msgs.length - 1];
  return {
    uuid: c.uuid,
    name: c.name || null,
    summary: c.summary || null,
    firstTs: iso(c.created_at),
    lastTs: iso(lastMsg && lastMsg.created_at) || iso(c.updated_at),
    prompts: prompts.length,
    firstPrompt: first ? textOf(blocksOf(first)).slice(0, 300) : null,
    lastPrompt: last ? textOf(blocksOf(last)).slice(0, 300) : null,
    messages: msgs.length,
    otherBranches: all.length - msgs.length,
    toolCalls,
  };
}

// How long a reply took: from the message before it to the reply's last timestamp. Text blocks have no
// timestamps, but the reply's created_at is set when it finishes streaming.
function seconds(prevTs, m, blocks) {
  const start = prevTs && Date.parse(prevTs);
  if (!start) return null;
  let end = Date.parse(m.created_at) || -Infinity;
  for (const x of blocks) for (const t of [x.start_timestamp, x.stop_timestamp]) if (t) end = Math.max(end, Date.parse(t));
  return end > start ? Math.round((end - start) / 1000) : null;
}

// Display items in the shape server.js's buildConversation returns for Claude Code transcripts.
function buildChat(c) {
  const msgs = mainBranch(c.chat_messages || []);
  const items = [];
  const results = {};
  let prevTs = null;
  for (const m of msgs) {
    const blocks = blocksOf(m);
    const ts = iso(m.created_at);
    for (const b of blocks) {
      if (b.type === 'tool_result') results[b.tool_use_id] = { text: clip(resultText(b.content)), isError: !!b.is_error };
    }
    if (m.sender === 'human') {
      if (isPrompt(m)) {
        const docs = blocks.filter(b => b.type === 'document').map(b => b.title).filter(Boolean);
        const names = [...new Set([...(m.attachments || []).map(a => a.file_name), ...docs])];
        const text = [textOf(blocks), ...names.map(n => `[attached: ${n}]`)].filter(Boolean).join('\n');
        items.push({ kind: 'user', ts, uuid: m.uuid, text: clip(text), images: blocks.filter(b => b.type === 'image').length, meta: false });
      }
      // After the prompt, so they land in its turn.
      (m.attachments || []).forEach((a, i) => {
        if (a.extracted_content) items.push({ kind: 'user', ts, uuid: `${m.uuid}:att${i}`, meta: true, label: `Attachment ${a.file_name}`, text: clip(a.extracted_content) });
      });
      blocks.forEach((b, i) => {
        if (b.type === 'injected_prompt_block' && b.prompt && b.prompt.trim()) {
          items.push({ kind: 'user', ts, uuid: `${m.uuid}:inj${i}`, meta: true, label: `Added by claude.ai${b.injection_source ? ` (${b.injection_source})` : ''}`, text: clip(b.prompt.trim()) });
        }
      });
    } else {
      const out = [];
      let toolCalls = 0;
      for (const b of blocks) {
        if (b.type === 'text') out.push({ type: 'text', text: b.text || '' });
        else if (b.type === 'thinking') {
          const sums = (b.summaries || []).map(s => s.summary).filter(Boolean);
          out.push({ type: 'thinking', text: b.thinking || (sums.length ? sums.map(s => `- ${s}`).join('\n') : '') });
        } else if (b.type === 'tool_use') { out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input }); toolCalls++; }
      }
      items.push({ kind: 'assistant', ts, id: m.uuid, model: null, blocks: out, usage: null, cost: null, stop: null, toolCalls, secs: seconds(prevTs, m, blocks) });
    }
    prevTs = m.created_at;
  }
  return { items, results };
}

module.exports = { findExports, readExport, summarize, buildChat };
