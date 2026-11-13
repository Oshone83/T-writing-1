// lib/chart.js — an SVG scatter chart: one mark per payment and method, delay on the y axis.
// Polling delays form a saw-tooth (they grow until the next poll, then drop); webhook delays stay flat.
export function renderChart(rows, { title = 'Delay from payment to "app knows", per payment', subtitle = '' } = {}) {
  const W = 900, H = 420, m = { l: 64, r: 24, t: 76, b: 56 };
  const pts = rows.flatMap((r) => [['poll', r.poll_ms], ['webhook', r.webhook_ms]]
    .filter(([, t]) => t != null && r.created_ms != null)
    .map(([method, t]) => ({ method, id: r.id, x: r.created_ms, y: (t - r.created_ms) / 1000 })));
  const x0 = Math.min(...rows.map((r) => r.created_ms));
  const spanS = Math.max(1, (Math.max(...rows.map((r) => r.created_ms)) - x0) / 1000);
  const nice = (v) => [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => v / s <= 8) ?? 1200;
  const xStep = nice(spanS), xMax = Math.ceil(spanS / xStep) * xStep;
  const yMaxRaw = Math.max(1, ...pts.map((p) => p.y));
  const yStep = nice(yMaxRaw), yMax = Math.ceil(yMaxRaw / yStep) * yStep;
  const sx = (t) => m.l + ((t - x0) / 1000 / xMax) * (W - m.l - m.r);
  const sy = (v) => H - m.b - (Math.max(0, v) / yMax) * (H - m.t - m.b);
  const ticks = (max, step) => Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const dot = (p) => {
    const cx = sx(p.x), cy = sy(p.y);
    const tip = `<title>${p.method === 'poll' ? 'Polling' : 'Webhook'} · ${p.id} · delay ${p.y.toFixed(2)} s</title>`;
    return p.method === 'poll'
      ? `<circle class="poll" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5">${tip}</circle>`
      : `<rect class="webhook" x="${(cx - 4.5).toFixed(1)}" y="${(cy - 4.5).toFixed(1)}" width="9" height="9" rx="1.5">${tip}</rect>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">Circles: polling. Squares: webhook. x: when the payment succeeded; y: how long until the app knew.</desc>
<style>
  svg { --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --grid:#e4e3df; --poll:#2a78d6; --webhook:#eb6834; }
  @media (prefers-color-scheme: dark) { svg { --surface:#1a1a19; --ink:#f0efec; --ink2:#c3c2b7; --grid:#3a3936; --poll:#3987e5; --webhook:#d95926; } }
  .bg { fill: var(--surface); } .title { fill: var(--ink); font-size: 17px; font-weight: 600; }
  .sub, .tick, .axis, .legend { fill: var(--ink2); font-size: 12px; }
  .grid { stroke: var(--grid); } .zero { stroke: var(--ink2); }
  .poll { fill: var(--poll); stroke: var(--surface); stroke-width: 2; }
  .webhook { fill: var(--webhook); stroke: var(--surface); stroke-width: 2; }
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text class="title" x="${m.l}" y="28">${esc(title)}</text>
<text class="sub" x="${m.l}" y="48">${esc(subtitle)}</text>
<g transform="translate(${W - m.r - 190}, 44)">
  <circle class="poll" cx="6" cy="0" r="5"/><text class="legend" x="16" y="4">Polling</text>
  <rect class="webhook" x="80" y="-4.5" width="9" height="9" rx="1.5"/><text class="legend" x="95" y="4">Webhook</text>
</g>
${ticks(yMax, yStep).map((v) => `<line class="${v === 0 ? 'zero' : 'grid'}" x1="${m.l}" x2="${W - m.r}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/><text class="tick" x="${m.l - 8}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join('\n')}
${ticks(xMax, xStep).map((v) => `<text class="tick" x="${sx(x0 + v * 1000).toFixed(1)}" y="${H - m.b + 18}" text-anchor="middle">${v}</text>`).join('\n')}
<text class="axis" x="${(m.l + W - m.r) / 2}" y="${H - 14}" text-anchor="middle">Seconds since the first payment</text>
<text class="axis" transform="translate(18 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle">Delay (s)</text>
${pts.filter((p) => p.method === 'poll').map(dot).join('\n')}
${pts.filter((p) => p.method === 'webhook').map(dot).join('\n')}
</svg>
`;
}
