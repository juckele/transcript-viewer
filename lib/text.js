'use strict';
// Text helpers shared by the Claude Code and claude.ai chat readers.

const MAX_RESULT_CHARS = 20000;

function clip(s) {
  if (typeof s !== 'string') s = JSON.stringify(s, null, 2);
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `\n… [${s.length - MAX_RESULT_CHARS} more characters]` : s;
}

// The text of a tool result's content. "knowledge" parts are web search and fetch results in claude.ai chats.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => {
      if (!b || typeof b !== 'object') return String(b);
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return '[image]';
      if (b.type === 'knowledge') return [b.title, b.url, b.text].filter(Boolean).join('\n');
      return JSON.stringify(b);
    }).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

module.exports = { MAX_RESULT_CHARS, clip, resultText };
