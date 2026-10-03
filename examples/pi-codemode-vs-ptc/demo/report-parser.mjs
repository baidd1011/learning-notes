// Extract the model's report without modifying its original text or facts.
export function parseReport(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(clean); } catch {}
  for (let start = 0; start < clean.length; start++) {
    if (clean[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < clean.length; i++) {
      const c = clean[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const value = JSON.parse(clean.slice(start, i + 1));
          if (typeof value.matchedCount === 'number' && Array.isArray(value.top3)) return value;
        } catch {}
        break;
      }
    }
  }
  throw new Error('模型最终响应中没有有效的订单报告 JSON；原文已保留。');
}
