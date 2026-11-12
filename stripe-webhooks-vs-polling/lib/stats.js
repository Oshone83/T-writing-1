// lib/stats.js — small, dependency-free statistics used by analyze.js.

// Nearest-rank percentile: the smallest value with at least p of the data at or below it.
// Always returns a value that actually occurred, which is what you want for "p95 delay".
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarize(values) {
  if (!values.length) return { n: 0, median: null, p95: null, max: null, min: null, mean: null };
  return {
    n: values.length,
    median: median(values),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
    min: Math.min(...values),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

// Number of pairs (i<j) where a later-created payment was delivered before an earlier one.
export function countInversions(seq) {
  let n = 0;
  for (let i = 0; i < seq.length; i++) for (let j = i + 1; j < seq.length; j++) if (seq[i] > seq[j]) n++;
  return n;
}

// Counts code lines: not blank, not a // comment line.
export function countCodeLines(source) {
  return source.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
}
