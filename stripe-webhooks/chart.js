// chart.js: writes chart.html, one dot per payment per method.
// x = when the payment was created, y = delay until the app knew. Open the file in a browser
// and screenshot it for the article. Usage: node chart.js [out=chart.html]
import { writeFileSync } from 'node:fs';
import { db } from './db.js';
import { summarize } from './stats.js';

const out = process.argv[2] ?? 'chart.html';
const rows = db.prepare(`
  SELECT s.id, s.method, p.created_ms, s.seen_ms - p.created_ms AS delay_ms
  FROM seen s JOIN payments p ON p.id = s.id
  WHERE s.method IN ('poll', 'webhook')
  ORDER BY p.created_ms
`).all();
if (!rows.length) {
  console.error('No rows in seen joined to payments yet. Run create-payments.js with the poller and receiver up.');
  process.exit(1);
}

const SERIES = [
  { key: 'poll', label: 'Polling every 60 s', shape: 'circle' },
  { key: 'webhook', label: 'Webhook', shape: 'square' },
];

// Geometry (viewBox units; the SVG scales to its container).
const W = 760, H = 380, M = { top: 16, right: 24, bottom: 44, left: 52 };
const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
const t0 = Math.min(...rows.map((r) => r.created_ms));
const xMaxMin = Math.max(1, (Math.max(...rows.map((r) => r.created_ms)) - t0) / 60000);
const yMinS = Math.min(0, Math.floor(Math.min(...rows.map((r) => r.delay_ms)) / 1000));
const yMaxS = Math.max(10, Math.ceil(Math.max(...rows.map((r) => r.delay_ms)) / 1000 / 10) * 10);
const x = (ms) => M.left + ((ms - t0) / 60000 / xMaxMin) * iw;
const y = (ms) => M.top + ih - ((ms / 1000 - yMinS) / (yMaxS - yMinS)) * ih;

const niceStep = (span, target) => {
  const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
};
const yStep = niceStep(yMaxS - yMinS, 6), xStep = niceStep(xMaxMin, 8);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let grid = '';
for (let v = Math.ceil(yMinS / yStep) * yStep; v <= yMaxS + 1e-9; v += yStep) {
  const yy = y(v * 1000).toFixed(1);
  grid += `<line class="grid${v === 0 ? ' zero' : ''}" x1="${M.left}" x2="${W - M.right}" y1="${yy}" y2="${yy}"/>` +
    `<text class="tick" x="${M.left - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${v}</text>`;
}
for (let v = 0; v <= xMaxMin + 1e-9; v += xStep) {
  const xx = (M.left + (v / xMaxMin) * iw).toFixed(1);
  grid += `<text class="tick" x="${xx}" y="${H - M.bottom + 18}" text-anchor="middle">${+v.toFixed(2)}</text>`;
}

const mark = (s, cx, cy) => s.shape === 'circle'
  ? `<circle class="dot s-${s.key}" cx="${cx}" cy="${cy}" r="4"/>`
  : `<rect class="dot s-${s.key}" x="${(cx - 4).toFixed(1)}" y="${(cy - 4).toFixed(1)}" width="8" height="8" rx="1.5"/>`;

let dots = '';
for (const s of SERIES) {
  for (const r of rows.filter((r) => r.method === s.key)) {
    const cx = x(r.created_ms).toFixed(1), cy = y(r.delay_ms).toFixed(1);
    const tip = `${s.label}|${r.id}|${new Date(r.created_ms).toISOString().slice(11, 19)} UTC|${(r.delay_ms / 1000).toFixed(2)} s`;
    dots += `<g class="pt" data-tip="${esc(tip)}">${mark(s, +cx, +cy)}<circle class="hit" cx="${cx}" cy="${cy}" r="10"/></g>`;
  }
}

const summary = SERIES.map((s) => ({ ...s, ...summarize(rows.filter((r) => r.method === s.key).map((r) => r.delay_ms)) }));
const legend = summary.map((s) =>
  `<span class="key"><svg width="12" height="12" aria-hidden="true">${s.shape === 'circle'
    ? `<circle class="s-${s.key}" cx="6" cy="6" r="5"/>` : `<rect class="s-${s.key}" x="1" y="1" width="10" height="10" rx="1.5"/>`}</svg>` +
  `${esc(s.label)} <span class="muted">median ${(s.median / 1000).toFixed(1)} s</span></span>`).join('');

const tableRows = rows.map((r) =>
  `<tr><td>${esc(r.id)}</td><td>${r.method}</td><td>${new Date(r.created_ms).toISOString()}</td><td class="num">${(r.delay_ms / 1000).toFixed(2)}</td></tr>`).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Delay Chart</title>
<style>
:root { color-scheme: light; --surface:#fcfcfb; --text:#0b0b0b; --text-2:#52514e; --muted:#7a7974; --grid:#e6e5e0; --axis:#b9b8b1;
  --s-poll:#2a78d6; --s-webhook:#eb6834; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --surface:#1a1a19; --text:#f0efec;
  --text-2:#c3c2b7; --muted:#8f8e86; --grid:#2e2e2c; --axis:#55544f; --s-poll:#3987e5; --s-webhook:#d95926; } }
:root[data-theme="dark"] { color-scheme: dark; --surface:#1a1a19; --text:#f0efec; --text-2:#c3c2b7; --muted:#8f8e86;
  --grid:#2e2e2c; --axis:#55544f; --s-poll:#3987e5; --s-webhook:#d95926; }
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px; background:var(--surface); color:var(--text); font:14px/1.45 system-ui, sans-serif; }
main { max-width: 800px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 4px; } p { margin: 0 0 12px; color: var(--text-2); }
.legend { display:flex; flex-wrap:wrap; gap:16px; margin: 8px 0 4px; }
.key { display:inline-flex; align-items:center; gap:6px; } .muted { color: var(--muted); }
.wrap { position: relative; } svg.chart { width:100%; height:auto; display:block; overflow:visible; }
.grid { stroke: var(--grid); stroke-width: 1; } .grid.zero { stroke: var(--axis); }
.tick, .axis-label { fill: var(--muted); font-size: 12px; } .axis-label { fill: var(--text-2); }
.s-poll { fill: var(--s-poll); } .s-webhook { fill: var(--s-webhook); }
.dot { stroke: var(--surface); stroke-width: 2; paint-order: stroke; }
.hit { fill: transparent; cursor: default; } .pt:hover .dot { stroke: var(--text); stroke-width: 1.5; }
.tip { position:absolute; pointer-events:none; background:var(--surface); color:var(--text); border:1px solid var(--axis);
  border-radius:6px; padding:6px 8px; font-size:12px; line-height:1.4; white-space:nowrap; display:none; box-shadow:0 2px 8px rgb(0 0 0 / .12); }
.tip b { font-weight: 600; }
details { margin-top: 16px; } summary { cursor: pointer; color: var(--text-2); }
.tbl { overflow-x: auto; } table { border-collapse: collapse; font-size: 12px; margin-top: 8px; }
td, th { padding: 3px 10px 3px 0; text-align: left; border-bottom: 1px solid var(--grid); } .num { text-align: right; font-variant-numeric: tabular-nums; }
</style></head>
<body><main>
<h1>Delay from payment created to app knows, per payment</h1>
<p>${summary[0].n + summary[1].n} sightings of ${new Set(rows.map((r) => r.id)).size} test payments. Lower is faster.</p>
<div class="legend">${legend}</div>
<div class="wrap">
<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of delay in seconds against minutes since the first payment, polling versus webhook">
${grid}
<text class="axis-label" x="${M.left + iw / 2}" y="${H - 6}" text-anchor="middle">Minutes since first payment was created</text>
<text class="axis-label" transform="translate(14 ${M.top + ih / 2}) rotate(-90)" text-anchor="middle">Delay (s)</text>
${dots}
</svg>
<div class="tip" role="status"></div>
</div>
<details><summary>Show data table</summary><div class="tbl"><table>
<thead><tr><th>Payment</th><th>Method</th><th>Created (UTC)</th><th class="num">Delay (s)</th></tr></thead>
<tbody>${tableRows}</tbody></table></div></details>
</main>
<script>
const wrap = document.querySelector('.wrap'), tip = document.querySelector('.tip');
wrap.addEventListener('pointerover', (e) => {
  const g = e.target.closest('.pt'); if (!g) return;
  const [label, id, at, delay] = g.dataset.tip.split('|');
  tip.innerHTML = '<b>' + delay + '</b> · ' + label + '<br>' + id + '<br>created ' + at;
  tip.style.display = 'block';
});
wrap.addEventListener('pointermove', (e) => {
  if (tip.style.display !== 'block') return;
  const r = wrap.getBoundingClientRect(), w = tip.offsetWidth;
  let left = e.clientX - r.left + 12; if (left + w > r.width) left = e.clientX - r.left - w - 12;
  tip.style.left = Math.max(0, left) + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px';
});
wrap.addEventListener('pointerout', (e) => { if (e.target.closest('.pt')) tip.style.display = 'none'; });
</script>
</body></html>
`;
writeFileSync(out, html);
console.log(`Wrote ${out} (${rows.length} dots)`);
