'use strict';
// Shared by server.js and the sampler scripts.
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Where the sampler keeps its own state, and where sampler/analyze.js writes its result for the viewer.
function stateDir() {
  return process.env.CLAUDE_USAGE_STATE_DIR || path.join(HOME, '.local', 'state', 'claude-usage-sampler');
}
function analysisPath() { return path.join(stateDir(), 'analysis.json'); }

// The sampler's data folder, chosen the way sampler/install.sh chooses it.
function defaultDataDir() {
  if (process.env.CLAUDE_USAGE_DIR) return process.env.CLAUDE_USAGE_DIR;
  const repo = process.env.CLAUDE_USAGE_REPO;
  if (repo) return path.join(HOME, 'git', path.basename(repo.replace(/\/+$/, ''), '.git'));
  return path.join(HOME, '.local', 'share', 'claude-usage');
}

// Turns an API `usage` object into our token buckets. Cache writes are split into 5-minute and 1-hour.
function normUsage(raw) {
  const cc = raw.cache_creation || {};
  const cw = raw.cache_creation_input_tokens || 0;
  let cw1h = cc.ephemeral_1h_input_tokens || 0;
  let cw5 = cc.ephemeral_5m_input_tokens || 0;
  if (cw1h + cw5 !== cw) cw5 = Math.max(0, cw - cw1h); // missing breakdown: treat rest as 5m
  return {
    in: raw.input_tokens || 0, out: raw.output_tokens || 0, cr: raw.cache_read_input_tokens || 0,
    cw5, cw1h, think: (raw.output_tokens_details && raw.output_tokens_details.thinking_tokens) || 0,
  };
}

module.exports = { normUsage, stateDir, analysisPath, defaultDataDir };
