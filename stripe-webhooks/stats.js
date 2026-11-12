// stats.js: small, dependency-free helpers shared by analyze.js and chart.js.

export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Nearest-rank percentile: the smallest value with at least p% of values at or below it.
export function percentile(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1];
}

export function summarize(delaysMs) {
  if (delaysMs.length === 0) return { n: 0, median: null, p95: null, max: null, min: null };
  return {
    n: delaysMs.length,
    median: median(delaysMs),
    p95: percentile(delaysMs, 95),
    max: Math.max(...delaysMs),
    min: Math.min(...delaysMs),
  };
}

// Count timestamps per clock hour. Returns [{ hourStartMs, count }] sorted by hour.
export function perHour(timestampsMs) {
  const buckets = new Map();
  for (const t of timestampsMs) {
    const h = Math.floor(t / 3_600_000) * 3_600_000;
    buckets.set(h, (buckets.get(h) ?? 0) + 1);
  }
  return [...buckets].sort((a, b) => a[0] - b[0]).map(([hourStartMs, count]) => ({ hourStartMs, count }));
}

export const seconds = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(2));
