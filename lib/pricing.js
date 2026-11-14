'use strict';
// List-price cost of one API call, from pricing.json. Shared by server.js and sampler/analyze.js.
const fs = require('fs');
const path = require('path');

const PRICING = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pricing.json'), 'utf8'));

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

// u is a normUsage() bucket set. Returns { cost, parts, assumed } or null when the model has no known price.
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

module.exports = { PRICING, priceFor, costOf };
