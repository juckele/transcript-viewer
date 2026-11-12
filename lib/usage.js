'use strict';
// Shared by server.js and sampler/sample-usage.js.

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

module.exports = { normUsage };
