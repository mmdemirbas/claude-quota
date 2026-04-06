import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Write dashboard.html to the plugin dir if it doesn't exist yet. */
export function ensureDashboardHtml(): void {
  try {
    const dir = join(homedir(), '.claude', 'plugins', 'claude-quota');
    const htmlPath = join(dir, 'dashboard.html');
    if (!existsSync(htmlPath)) {
      writeFileSync(htmlPath, DASHBOARD_HTML, 'utf8');
    }
  } catch { /* ignore */ }
}


// ── Embedded CSS ──────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #0d1117;
  --bg2: #161b22;
  --bg3: #1c2333;
  --border: #30363d;
  --text: #e6edf3;
  --text2: #8b949e;
  --blue: #58a6ff;
  --green: #3fb950;
  --yellow: #d29922;
  --orange: #db6d28;
  --red: #f85149;
  --purple: #bc8cff;
  --cyan: #39d2c0;
  --radius: 12px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  min-height: 100vh;
  padding: 24px;
}

.header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 28px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.header h1 {
  font-size: 22px;
  font-weight: 600;
  color: var(--text);
}
.header h1 span { color: var(--blue); }
.header .meta {
  font-size: 13px;
  color: var(--text2);
}

/* ── Gauge cards ─────────────────────────────────────────── */

.gauges {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 28px;
}

.gauge-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.gauge-card .label {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text2);
}

.gauge-ring {
  position: relative;
  width: 130px;
  height: 130px;
}
.gauge-ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.gauge-ring .bg-ring {
  fill: none;
  stroke: var(--bg3);
  stroke-width: 10;
}
.gauge-ring .fg-ring {
  fill: none;
  stroke-width: 10;
  stroke-linecap: round;
  transition: stroke-dashoffset 1s ease;
}
.gauge-ring .proj-ring {
  fill: none;
  stroke-width: 10;
  opacity: 0.25;
}
.gauge-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.gauge-center .pct {
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
}
.gauge-center .proj {
  font-size: 12px;
  color: var(--text2);
  margin-top: 2px;
}

.gauge-footer {
  text-align: center;
  font-size: 12px;
  color: var(--text2);
  line-height: 1.6;
}
.gauge-footer .pace-glyph { font-weight: 700; }
.gauge-footer .reset-val { color: var(--cyan); font-weight: 600; }

/* ── Section panels ──────────────────────────────────────── */

.panel {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px 24px;
  margin-bottom: 20px;
}
.panel h2 {
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text2);
  margin-bottom: 16px;
}

/* ── Timeline ────────────────────────────────────────────── */

.timeline-track {
  position: relative;
  height: 56px;
  margin: 20px 0 8px;
}
.timeline-bar {
  position: absolute;
  top: 22px;
  left: 0;
  right: 0;
  height: 4px;
  background: var(--bg3);
  border-radius: 2px;
}
.timeline-now {
  position: absolute;
  top: 14px;
  width: 2px;
  height: 20px;
  background: var(--text);
  z-index: 2;
}
.timeline-now::after {
  content: 'now';
  position: absolute;
  top: -16px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  color: var(--text2);
  white-space: nowrap;
}
.timeline-marker {
  position: absolute;
  top: 8px;
  transform: translateX(-50%);
  text-align: center;
  z-index: 1;
}
.timeline-marker .dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin: 8px auto 4px;
}
.timeline-marker .tm-label {
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}
.timeline-marker .tm-time {
  font-size: 10px;
  color: var(--text2);
  white-space: nowrap;
}

/* ── Pace bars ───────────────────────────────────────────── */

.pace-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.pace-row:last-child { margin-bottom: 0; }
.pace-label {
  width: 70px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text2);
  text-align: right;
  flex-shrink: 0;
}
.pace-bar-track {
  flex: 1;
  height: 22px;
  background: var(--bg3);
  border-radius: 4px;
  position: relative;
  overflow: hidden;
}
.pace-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 1s ease;
}
.pace-bar-ideal {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--text);
  opacity: 0.5;
  z-index: 1;
}
.pace-bar-ideal::after {
  content: 'ideal';
  position: absolute;
  bottom: -14px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 9px;
  color: var(--text2);
  white-space: nowrap;
}
.pace-val {
  width: 48px;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

/* ── Money panel ─────────────────────────────────────────── */

.money-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.money-stat {
  background: var(--bg3);
  border-radius: 8px;
  padding: 16px;
}
.money-stat .ms-label {
  font-size: 11px;
  color: var(--text2);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}
.money-stat .ms-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.2;
}
.money-stat .ms-sub {
  font-size: 12px;
  color: var(--text2);
  margin-top: 2px;
}

.balance-bar-track {
  height: 10px;
  background: var(--bg3);
  border-radius: 5px;
  margin-top: 16px;
  overflow: hidden;
}
.balance-bar-fill {
  height: 100%;
  border-radius: 5px;
  transition: width 1s ease;
}

/* ── Responsive ──────────────────────────────────────────── */

@media (max-width: 600px) {
  body { padding: 12px; }
  .gauges { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .gauge-ring { width: 100px; height: 100px; }
  .gauge-center .pct { font-size: 22px; }
  .money-grid { grid-template-columns: 1fr; }
}

/* ── Empty state ─────────────────────────────────────────── */
.empty {
  text-align: center;
  padding: 48px 24px;
  color: var(--text2);
  font-size: 16px;
}
`;

// ── Embedded JS ──────────────────────────────────────────────────────────

const JS = `
var FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
var SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

function renderDashboard() {
  if (!DATA || !DATA.data) return;
  var raw = DATA.lastGoodData || DATA.data;
  if (raw.apiUnavailable && !DATA.lastGoodData) return;

  // Build dashboard data from cache shape
  var now = Date.now();
  var quotas = [];
  if (raw.fiveHour !== null && raw.fiveHour !== undefined)
    quotas.push({ id: '5h', label: '5-Hour', pct: raw.fiveHour,
      resetAt: raw.fiveHourResetAt ? new Date(raw.fiveHourResetAt).getTime() : null, windowMs: FIVE_HOUR_MS });
  if (raw.sonnet !== null && raw.sonnet !== undefined)
    quotas.push({ id: 'snt', label: 'Sonnet 7d', pct: raw.sonnet,
      resetAt: raw.sonnetResetAt ? new Date(raw.sonnetResetAt).getTime() : null, windowMs: SEVEN_DAY_MS });
  if (raw.sevenDay !== null && raw.sevenDay !== undefined)
    quotas.push({ id: '7d', label: '7-Day', pct: raw.sevenDay,
      resetAt: raw.sevenDayResetAt ? new Date(raw.sevenDayResetAt).getTime() : null, windowMs: SEVEN_DAY_MS });
  if (raw.opus !== null && raw.opus !== undefined)
    quotas.push({ id: 'ops', label: 'Opus 7d', pct: raw.opus,
      resetAt: raw.opusResetAt ? new Date(raw.opusResetAt).getTime() : null, windowMs: SEVEN_DAY_MS });

  var extraUsage = null;
  if (raw.extraUsage && raw.extraUsage.enabled) {
    var cg = (typeof CREDIT_GRANT !== 'undefined' && CREDIT_GRANT && CREDIT_GRANT.creditGrant) || raw.extraUsage.creditGrant || null;
    extraUsage = { enabled: true, monthlyLimit: raw.extraUsage.monthlyLimit,
      usedCredits: raw.extraUsage.usedCredits, creditGrant: cg };
  }

  var d = { planName: raw.planName, fetchedAt: raw.fetchedAt || DATA.timestamp, now: now,
    quotas: quotas, extraUsage: extraUsage };

  var app = document.getElementById('app');

  // ── Helpers ────────────────────────────────────────────
  function fmt(ms) {
    if (ms <= 0) return 'now';
    const m = Math.ceil(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return rm > 0 ? h + 'h ' + rm + 'm' : h + 'h';
    const days = Math.floor(h / 24), rh = h % 24;
    return rh > 0 ? days + 'd ' + rh + 'h' : days + 'd';
  }

  function fmtTime(ts) {
    const dt = new Date(ts);
    return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDate(ts) {
    const dt = new Date(ts);
    return dt.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtMoney(v) {
    if (v === 0) return '$0';
    if (v < 1) return '$' + v.toFixed(2);
    if (v < 100) return '$' + v.toFixed(2);
    if (v < 1000) return '$' + Math.round(v);
    return '$' + Math.round(v / 1000) + 'k';
  }

  function pctColor(p) {
    if (p >= 90) return 'var(--red)';
    if (p >= 75) return 'var(--orange)';
    if (p >= 50) return 'var(--yellow)';
    return 'var(--blue)';
  }

  function projColor(p) {
    if (p > 100) return 'var(--red)';
    if (p >= 80) return 'var(--yellow)';
    return 'var(--green)';
  }

  function calcPace(pct, resetAt, windowMs) {
    if (!resetAt || pct === null) return null;
    const remaining = resetAt - d.now;
    if (remaining <= 0 || remaining >= windowMs) return null;
    const elapsed = (windowMs - remaining) / windowMs;
    if (elapsed < 0.02) return null;
    const projected = Math.round(pct / elapsed);
    const paceRatio = pct / (elapsed * 100);
    let glyph, color;
    if (paceRatio < 0.85) { glyph = '↘'; color = 'var(--green)'; }
    else if (paceRatio <= 1.15) { glyph = '→'; color = 'var(--text2)'; }
    else { glyph = '↗'; color = projected > 100 ? 'var(--red)' : 'var(--yellow)'; }
    return { projected, glyph, color, elapsed, paceRatio };
  }

  // ── Gauge SVG ──────────────────────────────────────────
  function gaugeRing(pct, projected, size) {
    const r = (size - 12) / 2;
    const c = size / 2;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - pct / 100);
    const color = pctColor(pct);

    let projArc = '';
    if (projected !== null && projected > pct) {
      const projPct = Math.min(projected, 100);
      const projOffset = circ * (1 - projPct / 100);
      projArc = '<circle class="proj-ring" cx="' + c + '" cy="' + c + '" r="' + r + '" '
        + 'stroke="' + projColor(projected) + '" '
        + 'stroke-dasharray="' + circ + '" '
        + 'stroke-dashoffset="' + projOffset + '" />';
    }

    return '<svg viewBox="0 0 ' + size + ' ' + size + '">'
      + '<circle class="bg-ring" cx="' + c + '" cy="' + c + '" r="' + r + '" />'
      + projArc
      + '<circle class="fg-ring" cx="' + c + '" cy="' + c + '" r="' + r + '" '
      + 'stroke="' + color + '" '
      + 'stroke-dasharray="' + circ + '" '
      + 'stroke-dashoffset="' + offset + '" />'
      + '</svg>';
  }

  // ── Header ─────────────────────────────────────────────
  var USAGE_URL = 'https://claude.ai/settings/usage';
  var isRateLimited = DATA.data.apiError === 'rate-limited';
  var rlBadge = isRateLimited
    ? ' &middot; <span style="color:var(--yellow)">\\u21BB rate-limited</span>'
    : '';

  let html = '<div class="header">'
    + '<h1><span>Claude</span> Usage Dashboard</h1>'
    + '<div class="meta">' + d.planName
    + ' &middot; fetched ' + fmtTime(d.fetchedAt)
    + rlBadge
    + ' &middot; <a href="' + USAGE_URL + '" target="_blank" style="color:var(--blue)">usage page \\u2197</a>'
    + '</div></div>';

  if (d.quotas.length === 0) {
    html += '<div class="empty">No usage data available.'
      + '<br><a href="' + USAGE_URL + '" target="_blank" style="color:var(--blue)">View usage on claude.ai \\u2197</a></div>';
    app.innerHTML = html;
    return;
  }

  // ── Gauge cards ────────────────────────────────────────
  html += '<div class="gauges">';
  for (const q of d.quotas) {
    const pace = calcPace(q.pct, q.resetAt, q.windowMs);
    const projected = pace ? pace.projected : null;
    const ring = gaugeRing(q.pct, projected, 130);

    let footer = '';
    if (pace) {
      footer += '<span class="pace-glyph" style="color:' + pace.color + '">' + pace.glyph + '</span> ';
      footer += '<span style="color:' + projColor(pace.projected) + '">proj ' + pace.projected + '%</span><br>';
    }
    if (q.resetAt && q.resetAt > d.now) {
      const remaining = q.resetAt - d.now;
      footer += 'resets in <span class="reset-val">' + fmt(remaining) + '</span>';
      footer += '<br><span style="color:var(--text2)">' + fmtDate(q.resetAt) + '</span>';
    }

    html += '<div class="gauge-card">'
      + '<div class="label">' + q.label + '</div>'
      + '<div class="gauge-ring">' + ring
      + '<div class="gauge-center">'
      + '<div class="pct" style="color:' + pctColor(q.pct) + '">' + q.pct + '%</div>'
      + (projected !== null ? '<div class="proj">→ ' + projected + '%</div>' : '')
      + '</div></div>'
      + '<div class="gauge-footer">' + footer + '</div>'
      + '</div>';
  }
  html += '</div>';

  // ── Reset Timeline ─────────────────────────────────────
  const resets = d.quotas
    .filter(q => q.resetAt && q.resetAt > d.now)
    .map(q => ({ id: q.id, label: q.label, at: q.resetAt, pct: q.pct }))
    .sort((a, b) => a.at - b.at);

  if (resets.length > 0) {
    const earliest = d.now;
    const latest = Math.max(...resets.map(r => r.at));
    const span = latest - earliest;
    const padPct = 6;

    // Compute positions and push apart overlapping markers (min 8% gap)
    const positions = resets.map(r => ({
      ...r,
      pos: padPct + ((r.at - earliest) / span) * (100 - 2 * padPct),
    }));
    for (let i = 1; i < positions.length; i++) {
      if (positions[i].pos - positions[i - 1].pos < 8) {
        positions[i].pos = positions[i - 1].pos + 8;
      }
    }

    html += '<div class="panel"><h2>Reset Timeline</h2>';
    html += '<div class="timeline-track"><div class="timeline-bar"></div>';
    html += '<div class="timeline-now" style="left:' + padPct + '%"></div>';

    for (const r of positions) {
      const remaining = r.at - d.now;
      const color = pctColor(r.pct);
      html += '<div class="timeline-marker" style="left:' + r.pos + '%">'
        + '<div class="tm-label" style="color:' + color + '">' + r.id + '</div>'
        + '<div class="dot" style="background:' + color + '"></div>'
        + '<div class="tm-time">' + fmt(remaining) + '</div>'
        + '</div>';
    }
    html += '</div></div>';
  }

  // ── Pace Analysis ──────────────────────────────────────
  const paceData = d.quotas
    .map(q => ({ ...q, pace: calcPace(q.pct, q.resetAt, q.windowMs) }))
    .filter(q => q.pace);

  if (paceData.length > 0) {
    html += '<div class="panel"><h2>Pace Analysis</h2>';
    html += '<p style="font-size:12px;color:var(--text2);margin-bottom:14px">'
      + 'Current usage vs ideal pace. The white line marks where you should be if consuming evenly.</p>';

    for (const q of paceData) {
      const idealPct = Math.round(q.pace.elapsed * 100);
      const barPct = Math.min(q.pct, 100);
      const color = pctColor(q.pct);

      html += '<div class="pace-row">'
        + '<div class="pace-label">' + q.id + '</div>'
        + '<div class="pace-bar-track">'
        + '<div class="pace-bar-fill" style="width:' + barPct + '%;background:' + color + '"></div>'
        + '<div class="pace-bar-ideal" style="left:' + idealPct + '%"></div>'
        + '</div>'
        + '<div class="pace-val" style="color:' + color + '">' + q.pct + '%</div>'
        + '</div>';
    }
    html += '</div>';
  }

  // ── Extra Usage / Credit Balance ───────────────────────
  if (d.extraUsage) {
    const e = d.extraUsage;
    const balance = e.creditGrant !== null ? Math.max(0, e.creditGrant - e.usedCredits) : null;
    const balancePct = e.creditGrant ? Math.max(0, (balance / e.creditGrant) * 100) : 0;
    const monthlyPct = e.monthlyLimit > 0 ? Math.min(100, (e.usedCredits / e.monthlyLimit) * 100) : 0;

    // Project months remaining
    let monthsRemaining = null;
    if (balance !== null && e.usedCredits > 0) {
      const now = new Date(d.now);
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const dailyRate = e.usedCredits / Math.max(1, dayOfMonth - 1 + now.getHours() / 24);
      const monthlyProj = dailyRate * daysInMonth;
      if (monthlyProj > 0) monthsRemaining = Math.round(balance / monthlyProj * 10) / 10;
    }

    html += '<div class="panel"><h2>Extra Usage &amp; Credit Balance</h2>';
    html += '<div class="money-grid">';

    // Monthly usage
    html += '<div class="money-stat">'
      + '<div class="ms-label">Monthly Usage</div>'
      + '<div class="ms-value" style="color:' + (monthlyPct >= 80 ? 'var(--red)' : monthlyPct > 0 ? 'var(--yellow)' : 'var(--green)') + '">'
      + fmtMoney(e.usedCredits) + '</div>'
      + '<div class="ms-sub">of ' + fmtMoney(e.monthlyLimit) + ' limit (' + Math.round(monthlyPct) + '%)</div>'
      + '</div>';

    // Balance
    if (balance !== null) {
      const balColor = balance < 10 ? 'var(--red)' : balance < 50 ? 'var(--yellow)' : 'var(--green)';
      html += '<div class="money-stat">'
        + '<div class="ms-label">Credit Balance</div>'
        + '<div class="ms-value" style="color:' + balColor + '">' + fmtMoney(balance) + '</div>'
        + '<div class="ms-sub">of ' + fmtMoney(e.creditGrant) + ' grant'
        + (monthsRemaining !== null ? ' &middot; ~' + monthsRemaining + ' months at current pace' : '')
        + '</div></div>';
    }

    // Grant remaining
    if (balance !== null) {
      html += '<div class="money-stat" style="grid-column:1/-1">'
        + '<div class="ms-label">Credit Grant Remaining</div>'
        + '<div class="balance-bar-track">'
        + '<div class="balance-bar-fill" style="width:' + balancePct + '%;background:' + (balancePct < 20 ? 'var(--red)' : balancePct < 50 ? 'var(--yellow)' : 'var(--green)') + '"></div>'
        + '</div>'
        + '<div class="ms-sub" style="margin-top:6px">' + fmtMoney(balance) + ' remaining of ' + fmtMoney(e.creditGrant) + ' (' + Math.round(balancePct) + '%)</div>'
        + '</div>';
    }

    html += '</div></div>';
  }

  // ── Quota Detail Table ─────────────────────────────────
  html += '<div class="panel"><h2>Quota Details</h2>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
  html += '<tr style="color:var(--text2);text-align:left;border-bottom:1px solid var(--border)">'
    + '<th style="padding:8px 12px">Quota</th>'
    + '<th style="padding:8px 12px">Usage</th>'
    + '<th style="padding:8px 12px">Projected</th>'
    + '<th style="padding:8px 12px">Pace</th>'
    + '<th style="padding:8px 12px">Window Elapsed</th>'
    + '<th style="padding:8px 12px">Resets At</th>'
    + '<th style="padding:8px 12px">Time Left</th>'
    + '</tr>';

  for (const q of d.quotas) {
    const pace = calcPace(q.pct, q.resetAt, q.windowMs);
    const remaining = q.resetAt ? Math.max(0, q.resetAt - d.now) : null;
    const elapsed = pace ? Math.round(pace.elapsed * 100) : null;

    html += '<tr style="border-bottom:1px solid var(--border)">'
      + '<td style="padding:8px 12px;font-weight:600">' + q.label + '</td>'
      + '<td style="padding:8px 12px;color:' + pctColor(q.pct) + '">' + q.pct + '%</td>'
      + '<td style="padding:8px 12px;color:' + (pace ? projColor(pace.projected) : 'var(--text2)') + '">'
      + (pace ? pace.projected + '%' : '—') + '</td>'
      + '<td style="padding:8px 12px">'
      + (pace ? '<span style="color:' + pace.color + '">' + pace.glyph + '</span> '
        + (pace.paceRatio < 0.85 ? 'under' : pace.paceRatio <= 1.15 ? 'on' : 'over') + ' pace' : '—')
      + '</td>'
      + '<td style="padding:8px 12px">' + (elapsed !== null ? elapsed + '%' : '—') + '</td>'
      + '<td style="padding:8px 12px;color:var(--cyan)">'
      + (q.resetAt ? fmtDate(q.resetAt) : '—') + '</td>'
      + '<td style="padding:8px 12px">'
      + (remaining !== null ? fmt(remaining) : '—') + '</td>'
      + '</tr>';
  }
  html += '</table></div>';

  // ── Footer ─────────────────────────────────────────────
  html += '<div style="text-align:center;padding:16px;color:var(--text2);font-size:11px">'
    + 'Generated at ' + new Date(d.now).toLocaleString()
    + ' &middot; Data fetched at ' + new Date(d.fetchedAt).toLocaleString()
    + '</div>';

  app.innerHTML = html;
}
`;

// ── Loader: polls data.js every 5s ──────────────────────────────────────

// ── Loader: polls data.js + credit-grant.js every 5s ────────────────────

const LOADER = `
var DATA = null;
var CREDIT_GRANT = null;
var _seq = 0;
function _loadScript(src, cb) {
  var s = document.createElement('script');
  s.src = src + '?_=' + _seq;
  s.onload = function() { s.remove(); if (cb) cb(); };
  s.onerror = function() { s.remove(); if (cb) cb(); };
  document.head.appendChild(s);
}
function _load() {
  ++_seq;
  _loadScript('credit-grant.js', function() {
    _loadScript('data.js', function() {
      if (typeof renderDashboard === 'function') renderDashboard();
    });
  });
}
_load();
setInterval(_load, 5000);
`;

// ── Static HTML shell ───────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Usage Dashboard</title>
<style>
${CSS}
</style>
</head>
<body>
<div id="app"><div class="empty">Waiting for data&hellip;</div></div>
<script>
${LOADER}
</script>
<script>
${JS}
</script>
</body>
</html>`;
