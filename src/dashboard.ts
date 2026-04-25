import { mkdirSync, statSync } from 'node:fs';
import { writeFileSecure, checkFileSafe } from './secure-fs.js';
import {
  pluginDir, dashboardHtmlPath,
  CACHE_VAR_DATA, CACHE_VAR_CREDIT_GRANT,
  CACHE_FILE_DATA, CACHE_FILE_CREDIT_GRANT,
} from './paths.js';

/**
 * Write dashboard.html to the plugin dir if it isn't already present
 * with the right size and 0o600 mode. The HTML is content-pinned to
 * this build of the plugin, so once a same-version file is on disk
 * there is nothing to update — the previous unconditional rewrite
 * cost an open/fsync/chmod/rename per statusline tick.
 *
 * Routed through writeFileSecure so the file lands with mode 0o600
 * when we DO write. That matters because the dashboard JS is reloaded
 * from disk on every poll — a world-writable file is a second-user-
 * to-first-user code execution path if an attacker can replace the
 * HTML between renders. We re-validate the existing file's safety via
 * checkFileSafe so we never preserve a permissive or attacker-symlinked
 * copy: those are rewritten unconditionally.
 */
export function ensureDashboardHtml(): void {
  try {
    mkdirSync(pluginDir(), { recursive: true });
    const path = dashboardHtmlPath();
    const safety = checkFileSafe(path);
    if (safety.ok) {
      // Content is build-pinned, so a size match is a perfect identity
      // check. Avoids reading the file just to compare bytes.
      try {
        const st = statSync(path);
        if (st.size === DASHBOARD_HTML_BYTES) return;
      } catch { /* fall through to write */ }
    }
    writeFileSecure(path, DASHBOARD_HTML);
  } catch { /* ignore */ }
}


// ── Embedded CSS ──────────────────────────────────────────────────────────

const CSS = `
/* ── Design tokens ──────────────────────────────────────────────────────
 * Refined dark palette with an Anthropic-style warm coral accent. The
 * severity ramp (ok / warn / over / risk) is the primary expressive
 * channel — every saturated colour outside that ramp is reserved for
 * brand identity (the coral) so eyes land on the data, not the chrome.
 */
:root {
  --bg:        #0e0e12;
  --bg-card:   #14141b;
  --bg-inset:  #1c1c26;
  --border:    #262633;
  --border-2:  #353546;
  --text:      #ecedf2;
  --text-2:    #9a9eaa;
  --text-3:    #62656f;

  --accent:    #f08c64;          /* warm coral, brand mark */
  --accent-d:  #c66a47;

  --ok:        #6ee7a7;
  --warn:      #f5b14a;
  --over:      #f08c64;
  --risk:      #ef4444;

  --mono: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Helvetica, Arial, sans-serif;

  --radius:   8px;
  --radius-s: 4px;

  /* Track height for quota bars: 12px gives enough room to read the
   * filled / over / projected / wasted layers without dominating the card. */
  --bar-h:    12px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html { color-scheme: dark; }

body {
  font-family: var(--sans);
  background: var(--bg);
  background-image:
    radial-gradient(1200px 800px at 80% -20%, rgba(240,140,100,0.04), transparent 60%),
    radial-gradient(900px 600px at -10% 110%, rgba(110,231,167,0.025), transparent 60%);
  color: var(--text);
  line-height: 1.5;
  min-height: 100vh;
  padding: 28px 32px 48px;
  font-feature-settings: 'cv11', 'ss01';
}

main { max-width: 1100px; margin: 0 auto; }

/* Tabular numerals everywhere we render a stat — keeps columns aligned
 * across cards (33% next to 6% should line up by digit). */
.num, .stat, .pct, .proj, .reset, .money { font-variant-numeric: tabular-nums; }

/* ── Header ─────────────────────────────────────────────────────────── */

.header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 18px;
  margin-bottom: 22px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.brand { display: flex; align-items: baseline; gap: 14px; line-height: 1; }
.brand .mark {
  width: 10px; height: 10px;
  background: var(--accent);
  border-radius: 2px;
  transform: translateY(2px);
}
.brand .plan {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.brand .tag {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.head-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 13px;
  color: var(--text-2);
}
.head-meta .pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--mono);
  font-size: 11px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--bg-card);
}
.head-meta .pill.warn { color: var(--warn); border-color: rgba(245,177,74,0.4); }
.head-meta .pill .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 0 rgba(110,231,167,0.6);
  animation: pulse 2.4s ease-in-out infinite;
}
.head-meta .pill.warn .dot {
  background: var(--warn);
  box-shadow: 0 0 0 0 rgba(245,177,74,0.6);
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(110,231,167,0.5); }
  50%      { box-shadow: 0 0 0 5px rgba(110,231,167,0); }
}
.head-meta a {
  color: var(--text-2);
  text-decoration: none;
  border-bottom: 1px dotted var(--border-2);
  padding-bottom: 1px;
  transition: color .15s ease, border-color .15s ease;
}
.head-meta a:hover { color: var(--accent); border-color: var(--accent); }

/* ── Banner (rate-limit / api error) ─────────────────────────────────── */

.banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 22px;
  background: var(--bg-card);
  border: 1px solid rgba(245,177,74,0.3);
  border-left: 3px solid var(--warn);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--text-2);
}
.banner strong { color: var(--warn); font-weight: 600; }

/* ── Card grid ──────────────────────────────────────────────────────── */

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 14px;
  margin-bottom: 22px;
}

.card {
  position: relative;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px 22px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  transition: border-color .2s ease, transform .15s ease;
}
.card:hover { transform: translateY(-1px); }
.card:hover { border-color: var(--border-2); }

/* Severity stripe on the left — drawn via ::before so we don't need to
 * paint the entire border in colour (looked too loud). */
.card::before {
  content: '';
  position: absolute;
  left: -1px; top: -1px; bottom: -1px;
  width: 3px;
  background: transparent;
  border-radius: var(--radius) 0 0 var(--radius);
}
.card.sev-warn::before { background: var(--warn); }
.card.sev-over::before { background: var(--over); }
.card.sev-risk::before { background: var(--risk); }

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.card-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-2);
}
.card-reset-head {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.02em;
}
.card-reset-head .v {
  color: var(--text);
  font-weight: 500;
}

.card-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.card-stat .pct {
  font-family: var(--mono);
  font-size: 38px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1;
}
.card-stat .pct .pct-unit {
  font-size: 22px;
  font-weight: 500;
  color: var(--text-2);
  margin-left: 1px;
}
.card-stat .proj {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text-2);
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  white-space: nowrap;
}
.card-stat .proj .glyph {
  font-size: 16px;
  line-height: 1;
  color: var(--text-2);
  position: relative;
  top: 2px;
}
.card-stat .proj .glyph.under { color: var(--ok); }
.card-stat .proj .glyph.over  { color: var(--warn); }
.card-stat .proj .glyph.over.risk { color: var(--risk); }
.card-stat .proj .label { color: var(--text-3); }
.card-stat .proj .v { color: var(--text); font-weight: 500; }

/* ── Quota bar ──────────────────────────────────────────────────────── */

.bar {
  position: relative;
  height: var(--bar-h);
  background: var(--bg-inset);
  border-radius: 999px;
  overflow: visible;
}
.bar-fill {
  position: absolute;
  top: 0; bottom: 0; left: 0;
  border-radius: 999px;
  background: var(--accent);
  /* dim portion = current usage up to ideal (or full current if under-pace).
   * The bar is rendered in three CSS layers: bar-fill (dim coral, the
   * "you're here" baseline), bar-over (bright coral overlay for the
   * over-pace section), bar-proj (very dim coral showing the projected
   * end-of-window position). Layer opacities pull apart on the same hue
   * so the eye can read all three at once. */
  opacity: 0.55;
}
.bar-over {
  position: absolute;
  top: 0; bottom: 0;
  background: var(--accent);
  border-radius: 0 999px 999px 0;
  /* full opacity (no override) — this is the "exceeded ideal" portion
   * and should read brighter than the baseline fill. */
}
.bar-proj {
  position: absolute;
  top: 0; bottom: 0;
  background: var(--accent);
  opacity: 0.22;
}
.bar-ideal {
  position: absolute;
  top: -3px; bottom: -3px;
  width: 2px;
  background: var(--text);
  opacity: 0.55;
  border-radius: 1px;
  z-index: 2;
}

/* Severity tinting routes through the bar's inner colours via class. */
.bar.sev-ok    .bar-fill, .bar.sev-ok    .bar-over, .bar.sev-ok    .bar-proj { background: var(--ok); }
.bar.sev-warn  .bar-fill, .bar.sev-warn  .bar-over, .bar.sev-warn  .bar-proj { background: var(--warn); }
.bar.sev-over  .bar-fill, .bar.sev-over  .bar-over, .bar.sev-over  .bar-proj { background: var(--over); }
.bar.sev-risk  .bar-fill, .bar.sev-risk  .bar-over, .bar.sev-risk  .bar-proj { background: var(--risk); }

.card-foot {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.card-foot .ideal-label { font-style: normal; }
.card-foot .ideal-label .v { color: var(--text-2); }
.card-foot.empty { justify-content: center; }

/* ── Money / Extra usage ────────────────────────────────────────────── */

.money-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px 28px;
  align-items: end;
}
.money-card.span { grid-column: 1 / -1; }

.money-head {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 4px;
}
.money-head .title {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--text-2); font-weight: 600;
}
.money-head .sub { font-size: 12px; color: var(--text-3); font-family: var(--mono); }

.money-stat .ms-label {
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 6px;
}
.money-stat .ms-value {
  font-family: var(--mono);
  font-size: 26px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.01em;
}
.money-stat .ms-sub {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 4px;
  font-family: var(--mono);
}

.money-bar {
  grid-column: 1 / -1;
  height: 6px;
  background: var(--bg-inset);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 4px;
}
.money-bar-fill { height: 100%; border-radius: 999px; }

/* ── Empty state ────────────────────────────────────────────────────── */

.empty-state {
  padding: 64px 24px;
  text-align: center;
  color: var(--text-2);
  background: var(--bg-card);
  border: 1px dashed var(--border-2);
  border-radius: var(--radius);
}
.empty-state .e-title { font-size: 16px; color: var(--text); margin-bottom: 6px; }
.empty-state .e-sub   { font-size: 13px; color: var(--text-2); }
.empty-state a { color: var(--accent); text-decoration: none; }
.empty-state a:hover { color: var(--text); }

/* ── Footer ─────────────────────────────────────────────────────────── */

footer {
  margin-top: 32px;
  text-align: center;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
}

/* ── Responsive ─────────────────────────────────────────────────────── */

@media (max-width: 720px) {
  body { padding: 18px 16px 40px; }
  .header { gap: 12px; }
  .brand .plan { font-size: 22px; }
  .cards { grid-template-columns: 1fr; gap: 10px; }
  .money-card { grid-template-columns: 1fr; gap: 14px; }
  .card-stat .pct { font-size: 30px; }
}
`;

// ── Embedded JS ──────────────────────────────────────────────────────────

const JS = `
var FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
var SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// HTML-escape helper — MUST stay in lockstep with src/html-escape.ts.
// Applied to every value whose origin is outside this codebase (API
// responses, credentials file, cached profile) before string-concatenating
// into innerHTML. Numbers/constants from the codebase bypass it.
function _esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Single severity classifier for the entire UI. Both the headline %
// colour and the card stripe + bar tint route through this — they
// must agree, otherwise a card looks "warn"-yellow while its bar
// glows green.
function severityFor(pct, projected) {
  var p = projected != null && projected > pct ? projected : pct;
  if (p >= 100 || pct >= 95) return 'risk';
  if (p >= 85)               return 'over';
  if (p >= 65)               return 'warn';
  return 'ok';
}

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
    var cg = (typeof CREDIT_GRANT !== 'undefined' && CREDIT_GRANT && CREDIT_GRANT.creditGrant != null)
      ? CREDIT_GRANT.creditGrant
      : (raw.extraUsage.creditGrant != null ? raw.extraUsage.creditGrant : null);
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
    if (v < 100) return '$' + v.toFixed(2);
    if (v < 1000) return '$' + Math.round(v);
    return '$' + Math.round(v / 1000) + 'k';
  }

  function calcPace(pct, resetAt, windowMs) {
    if (!resetAt || pct === null) return null;
    const remaining = resetAt - d.now;
    if (remaining <= 0 || remaining >= windowMs) return null;
    const elapsed = (windowMs - remaining) / windowMs;
    if (elapsed < 0.02) return null;
    const projected = Math.min(Math.round(pct / elapsed), 999);
    const paceRatio = pct / (elapsed * 100);
    let glyph, paceWord;
    if (paceRatio < 0.85)       { glyph = '↘'; paceWord = 'under'; }
    else if (paceRatio <= 1.15) { glyph = '→'; paceWord = 'on'; }
    else                        { glyph = '↗'; paceWord = 'over'; }
    return { projected, glyph, paceWord, elapsed, paceRatio };
  }

  // ── Top: header + status pill ──────────────────────────
  const USAGE_URL = 'https://claude.ai/settings/usage';
  const isRateLimited = DATA.data && DATA.data.apiError === 'rate-limited';
  const agoSec = Math.max(0, Math.floor((d.now - d.fetchedAt) / 1000));
  // Buckets: <60s -> seconds; <60m -> minutes; <24h -> hours; else days.
  // Avoids the "1612m ago" weirdness when a tab has been open all day.
  const agoStr = agoSec < 60
    ? agoSec + 's ago'
    : agoSec < 3600
      ? Math.floor(agoSec / 60) + 'm ago'
      : agoSec < 86400
        ? Math.floor(agoSec / 3600) + 'h ago'
        : Math.floor(agoSec / 86400) + 'd ago';
  const pillClass = isRateLimited ? 'pill warn' : 'pill';
  const pillText = isRateLimited
    ? '<span class="dot"></span> rate-limited \\u00b7 retrying'
    : '<span class="dot"></span> live \\u00b7 ' + agoStr;

  let html = '<main>';
  html += '<header class="header">'
    + '<div class="brand">'
    +   '<span class="mark"></span>'
    +   '<span class="plan">' + _esc(d.planName || 'Claude') + '</span>'
    +   '<span class="tag">usage</span>'
    + '</div>'
    + '<div class="head-meta">'
    +   '<span class="' + pillClass + '">' + pillText + '</span>'
    +   '<a href="' + USAGE_URL + '" target="_blank" rel="noopener">view on claude.ai \\u2197</a>'
    + '</div>'
    + '</header>';

  // ── Banner: surfaces stale/rate-limited state above the cards ────
  if (isRateLimited) {
    html += '<div class="banner">'
      + '<strong>Showing last-good values.</strong> '
      + 'The usage API rate-limited the most recent fetch '
      + '(' + fmtTime(d.fetchedAt) + '). Numbers will refresh once the '
      + 'backoff window clears.'
      + '</div>';
  }

  if (d.quotas.length === 0 && !d.extraUsage) {
    html += '<div class="empty-state">'
      + '<div class="e-title">No usage data yet</div>'
      + '<div class="e-sub">Once Claude Code reports activity, your quotas will appear here. '
      + '<a href="' + USAGE_URL + '" target="_blank" rel="noopener">View usage on claude.ai</a>.'
      + '</div></div></main>';
    app.innerHTML = html;
    return;
  }

  // ── Cards ────────────────────────────────────────────
  html += '<div class="cards">';
  for (const q of d.quotas) {
    const pace = calcPace(q.pct, q.resetAt, q.windowMs);
    const projected = pace ? pace.projected : null;
    const idealPct = pace ? Math.round(pace.elapsed * 100) : null;
    const sev = severityFor(q.pct, projected);

    // Bar geometry: filled = min(pct, ideal); over = pct - ideal; proj = projected - pct.
    // All three clamped to [0,100] so a 999% projected doesn't over-flow the track.
    const cur = Math.max(0, Math.min(100, q.pct));
    const ideal = idealPct == null ? null : Math.max(0, Math.min(100, idealPct));
    const projC = projected == null ? null : Math.max(0, Math.min(100, projected));
    const overPace = ideal != null && cur > ideal;
    const fillEnd = overPace ? ideal : cur;
    const overEnd = overPace ? cur : null;
    const projStart = cur;
    const projEnd = projC != null && projC > cur ? projC : null;

    let bar = '<div class="bar sev-' + sev + '">';
    bar += '<div class="bar-fill" style="width:' + fillEnd + '%"></div>';
    if (overEnd != null) {
      bar += '<div class="bar-over" style="left:' + ideal + '%;width:' + (overEnd - ideal) + '%"></div>';
    }
    if (projEnd != null) {
      bar += '<div class="bar-proj" style="left:' + projStart + '%;width:' + (projEnd - projStart) + '%"></div>';
    }
    if (ideal != null) {
      bar += '<div class="bar-ideal" style="left:' + ideal + '%"></div>';
    }
    bar += '</div>';

    // Stat row right side: glyph + projected. Glyph colour tracks
    // pace direction (under = ok green, over = warn yellow, over+risk
    // = red). The projection number itself is bright text-1 so the
    // eye lands on the prediction, not the label.
    let projHtml = '';
    if (projected != null && pace) {
      const glyphCls = pace.paceWord === 'over'
        ? (sev === 'risk' ? 'glyph over risk' : 'glyph over')
        : pace.paceWord === 'under' ? 'glyph under' : 'glyph';
      projHtml = '<span class="proj">'
        +   '<span class="' + glyphCls + '">' + pace.glyph + '</span>'
        +   '<span><span class="label">proj</span> <span class="v">' + projected + '%</span></span>'
        + '</span>';
    } else if (projected != null) {
      projHtml = '<span class="proj">'
        +   '<span><span class="label">proj</span> <span class="v">' + projected + '%</span></span>'
        + '</span>';
    }

    // Head: title plus the reset countdown (the most actionable
    // number on the card, so it gets prime real estate top-right).
    let headRight = '';
    if (q.resetAt && q.resetAt > d.now) {
      headRight = '<span class="card-reset-head">resets in <span class="v">'
        + fmt(q.resetAt - d.now) + '</span></span>';
    }

    // Foot: absolute reset time on left, ideal-pace marker label on
    // right when pace data exists. Both subtle — they're context for
    // the eye that's already focused on the headline %.
    let footLeft = q.resetAt ? fmtDate(q.resetAt) : '';
    let footRight = (idealPct != null)
      ? '<span class="ideal-label">ideal <span class="v">' + idealPct + '%</span></span>'
      : '';
    const footHtml = '<span>' + footLeft + '</span><span>' + footRight + '</span>';

    html += '<section class="card sev-' + sev + '">'
      + '<div class="card-head">'
      +   '<span class="card-title">' + _esc(q.label) + '</span>'
      +   headRight
      + '</div>'
      + '<div class="card-stat">'
      +   '<span class="pct">' + q.pct + '<span class="pct-unit">%</span></span>'
      +   projHtml
      + '</div>'
      + bar
      + '<div class="card-foot">' + footHtml + '</div>'
      + '</section>';
  }
  html += '</div>';

  // ── Extra usage / credit balance ─────────────────────────
  if (d.extraUsage) {
    const e = d.extraUsage;
    const balance = e.creditGrant != null ? Math.max(0, e.creditGrant - e.usedCredits) : null;
    const balancePct = (balance != null && e.creditGrant > 0)
      ? Math.max(0, (balance / e.creditGrant) * 100) : 0;
    const monthlyPct = e.monthlyLimit > 0
      ? Math.min(100, (e.usedCredits / e.monthlyLimit) * 100) : 0;
    const monthlySev = monthlyPct >= 90 ? 'risk' : monthlyPct >= 75 ? 'over' : monthlyPct > 0 ? 'warn' : 'ok';
    const balSev = balancePct < 10 ? 'risk' : balancePct < 30 ? 'over' : balancePct < 60 ? 'warn' : 'ok';

    let monthsRemaining = null;
    if (balance != null && e.usedCredits > 0) {
      const dt = new Date(d.now);
      const dayOfMonth = dt.getDate();
      const daysInMonth = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
      const dailyRate = e.usedCredits / Math.max(1, dayOfMonth - 1 + dt.getHours() / 24);
      const monthlyProj = dailyRate * daysInMonth;
      if (monthlyProj > 0) monthsRemaining = Math.round(balance / monthlyProj * 10) / 10;
    }

    const sevColorVar = function(s) { return 'var(--' + s + ')'; };

    html += '<section class="money-card span">'
      + '<div class="money-head">'
      +   '<span class="title">Extra usage</span>'
      +   '<span class="sub">' + Math.round(monthlyPct) + '% of monthly limit used</span>'
      + '</div>'
      + '<div class="money-stat">'
      +   '<div class="ms-label">This month</div>'
      +   '<div class="ms-value" style="color:' + sevColorVar(monthlySev) + '">' + fmtMoney(e.usedCredits) + '</div>'
      +   '<div class="ms-sub">of ' + fmtMoney(e.monthlyLimit) + ' limit</div>'
      + '</div>';

    if (balance != null) {
      html += '<div class="money-stat">'
        +   '<div class="ms-label">Credit balance</div>'
        +   '<div class="ms-value" style="color:' + sevColorVar(balSev) + '">' + fmtMoney(balance) + '</div>'
        +   '<div class="ms-sub">of ' + fmtMoney(e.creditGrant) + ' grant'
        +     (monthsRemaining != null ? ' \\u00b7 ~' + monthsRemaining + ' mo at pace' : '')
        +   '</div>'
        + '</div>';
      html += '<div class="money-bar">'
        + '<div class="money-bar-fill" style="width:' + balancePct + '%;background:' + sevColorVar(balSev) + '"></div>'
        + '</div>';
    }

    html += '</section>';
  }

  // ── Footer: single line, mono, dim. The pill in the header already
  // tells the user the freshness; the footer just records exact time. ──
  html += '<footer>fetched ' + new Date(d.fetchedAt).toLocaleString() + '</footer>';

  html += '</main>';
  app.innerHTML = html;
}
`;

// ── Loader: polls data.js + credit-grant.js every 5s, survives sleep ───
//
// File and variable names are interpolated from paths.ts so a rename
// on either side propagates through the build instead of silently
// drifting and breaking the dashboard.

const LOADER = `
var ${CACHE_VAR_DATA} = null;
var ${CACHE_VAR_CREDIT_GRANT} = null;
var _seq = 0;
var _lastLoad = 0;
var POLL_MS = 5000;
function _loadScript(src, cb) {
  var s = document.createElement('script');
  s.src = src + '?_=' + _seq;
  s.onload = function() { s.remove(); if (cb) cb(); };
  s.onerror = function() { s.remove(); if (cb) cb(); };
  document.head.appendChild(s);
}
function _load() {
  _lastLoad = Date.now();
  ++_seq;
  _loadScript('${CACHE_FILE_CREDIT_GRANT}', function() {
    _loadScript('${CACHE_FILE_DATA}', function() {
      if (typeof renderDashboard === 'function') renderDashboard();
    });
  });
}
// Reload immediately when tab becomes visible (handles background throttle + standby)
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && Date.now() - _lastLoad > POLL_MS) _load();
});
// Detect timer drift from sleep: if interval fires late, data is stale
setInterval(function() {
  var drift = Date.now() - _lastLoad;
  if (drift >= POLL_MS) _load();
}, POLL_MS);
_load();
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

// Build-pinned, so its UTF-8 byte length is a constant. Computed once
// at module load instead of on every ensureDashboardHtml call.
const DASHBOARD_HTML_BYTES = Buffer.byteLength(DASHBOARD_HTML, 'utf8');
