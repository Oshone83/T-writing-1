// lib/stats.js — the two statistics the report needs, without a dependency.

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarize(values) {
  if (!values.length) return { n: 0, median: null, min: null, max: null };
  return { n: values.length, median: median(values), min: Math.min(...values), max: Math.max(...values) };
}
