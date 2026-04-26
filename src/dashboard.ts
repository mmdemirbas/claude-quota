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
 * paint the entire border in colour (looked too loud). The colour is
 * set per-card via the --card-color CSS variable, computed from the
 * card's "concern" % so the tone matches the bar fill. */
.card::before {
  content: '';
  position: absolute;
  left: -1px; top: -1px; bottom: -1px;
  width: 3px;
  background: var(--card-color, transparent);
  border-radius: var(--radius) 0 0 var(--radius);
  opacity: 0.85;
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}

/* ── Pace meter ───────────────────────────────────────────────────────
 * The card-head's primary signal: how fast the user is burning vs
 * the ideal rate (quota%/elapsed%). The track has a centre line at
 * "on pace"; the fill grows leftward when under-pace and rightward
 * when over-pace. Visual length encodes magnitude; colour escalates
 * as the deviation gets ugly. The signed % beside the gauge gives
 * the precise reading for a second-glance check.
 */
.pace-meter {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 11px;
}
.pace-track {
  position: relative;
  width: 80px;
  height: 8px;
  background: var(--bg-inset);
  border-radius: 999px;
  overflow: hidden;
}
.pace-center {
  position: absolute;
  left: 50%; top: 0; bottom: 0;
  width: 1px;
  margin-left: -0.5px;
  background: var(--text-2);
  opacity: 0.5;
  z-index: 1;
}
.pace-fill {
  position: absolute;
  top: 0; bottom: 0;
}
.pace-num { color: var(--text); font-weight: 600; min-width: 38px; text-align: right; }
.pace-num.under { color: var(--ok); }
.pace-num.warn  { color: var(--warn); }
.pace-num.bad   { color: var(--risk); }
.pace-meter.dim .pace-num { color: var(--text-3); }

/* Aside text. Projected end sits in card-foot left; reset times sit in
 * card-foot right. Both mono, dim. */
.aside {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.aside .v   { color: var(--text); font-weight: 500; }
.aside .v-2 { color: var(--text-2); }
.aside .lbl { color: var(--text-3); }
.aside.stack { display: inline-flex; flex-direction: column; gap: 2px; line-height: 1.3; text-align: right; }

/* ── Metric rows (quota + time per card) ──────────────────────────────
 * Each row is [label][bar][value%]. Asides live above (projected, in
 * card-head) and below (reset, in card-foot) so the bars get full
 * card width without competition. */

.metric {
  display: grid;
  grid-template-columns: 60px 1fr 56px;
  align-items: center;
  gap: 12px;
}
.metric .m-label {
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-3);
  text-align: right;
}
.metric .m-value {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  text-align: right;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.metric .m-value .m-unit {
  font-weight: 500;
  color: var(--text-2);
  margin-left: 1px;
}

/* ── Bar (two variants: quota [severity-tinted] + time [neutral]) ─────
 * Each bar carries up to two vertical line indicators: a solid line at
 * the "current" position (quota: now-usage; time: now-elapsed) and a
 * dashed line at the "estimated" end-of-window position (quota:
 * projected; time: 100% = reset). Drawing the same line type at the
 * same conceptual moment ("now" / "end of window") on both bars lets
 * the reader visually map the two metrics to each other. */

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
}
.bar-proj {
  position: absolute;
  top: 0; bottom: 0;
  background: var(--accent);
  opacity: 0.28;
}

/* Solid "current" line. Sits taller than the bar (top: -3 / bottom: -3)
 * so it reads as a marker, not a section boundary. */
.bar-now {
  position: absolute;
  top: -4px; bottom: -4px;
  width: 2px;
  margin-left: -1px;
  background: var(--text);
  border-radius: 1px;
  z-index: 3;
}
/* Dashed "estimated" line. Vertical dashes via repeating gradient. */
.bar-end {
  position: absolute;
  top: -4px; bottom: -4px;
  width: 2px;
  margin-left: -1px;
  background-image: repeating-linear-gradient(
    to bottom, var(--text-2) 0 3px, transparent 3px 6px);
  z-index: 3;
}

/* Quota bar: fill + trail colour set per-card via inline style so the
 * tone matches the actual %. The bar.bar-time variant overrides this
 * with a neutral grey, since time-elapsed is context, not an alarm. */

/* Time bar: neutral. The reader reads it as "context", not alarm. */
.bar.bar-time .bar-fill {
  background: var(--text-3) !important;
  opacity: 0.7;
}

/* Card foot: projected-end on the left, reset (relative + absolute)
 * stacked on the right. Either side can be empty when its data isn't
 * available yet (early-window pace, or no active window). */
.card-foot {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  padding-top: 4px;
}
.card-foot.empty {
  justify-content: center;
}

/* ── Extra usage card ───────────────────────────────────────────────── */
/* Reuses the same .card / .metric scaffolding as the quota cards so the
 * visual rhythm of the dashboard stays consistent. The only addition
 * is a small balance/limit summary row beneath the two bars. */

.card.money .ms-summary {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-2);
  padding-top: 6px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.card.money .ms-summary .item .lbl {
  color: var(--text-3);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-size: 10px;
  margin-right: 4px;
}
.card.money .ms-summary .item .v {
  color: var(--text);
  font-weight: 600;
}

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

// Continuous colour ramp: 0% → mint, 50% → amber, 100% → red. HSL hue
// interpolation gives a smooth gradient through yellow at the midpoint
// without the muddy mid-tones RGB interpolation produces. Saturation
// and lightness are held roughly constant so the perceived brightness
// doesn't oscillate as hue shifts — only the temperature changes.
//
// 5% and 10% land at slightly different greens; 60% and 70% at
// distinguishable yellow-oranges. The reader extracts severity from
// the colour temperature alone, no need for tier thresholds.
function colorForPct(pct) {
  var p = Math.max(0, Math.min(100, pct));
  // Hue: 150 (mint) → 60 (yellow) → 0 (red).
  var h = p <= 50 ? 150 - (p / 50) * 90 : 60 - ((p - 50) / 50) * 60;
  return 'hsl(' + h.toFixed(0) + ', 70%, 62%)';
}

// "Concern" colour for the card stripe and any non-bar accents. When
// the user is over pace AND the projection is meaningfully higher
// than current, we colour by the projection — that's the value that
// will hit reality. Otherwise we colour by the current value.
//
// paceWord: 'under' | 'on' | 'over' | undefined.
function concernColor(pct, projected, paceWord) {
  var concern = (paceWord === 'over' && projected != null && projected > pct)
    ? projected : pct;
  return colorForPct(concern);
}

// Glanceable pace gauge. Returns HTML for the card-head meter that
// shows whether the user is burning faster (right of centre) or
// slower (left of centre) than the ideal rate, and by how much.
//
// The fill grows OUTWARD from the centre line, so visual length =
// magnitude of deviation. Cap the visual at ±100% deviation so a
// freshly-opened window (huge ratio noise) doesn't pin the bar to
// one edge — the numeric reading still shows the real value.
//
// The "fresh window" guard hides the meter when elapsed < 5%: the
// ratio is too noisy to be useful that early, and showing wild
// numbers undermines the trust-at-a-glance contract.
function paceMeter(pct, elapsedPct) {
  if (elapsedPct == null || elapsedPct < 5) {
    return '<span class="pace-meter dim">'
      +    '<span class="pace-track"><span class="pace-center"></span></span>'
      +    '<span class="pace-num">—</span>'
      +  '</span>';
  }
  var ratio = pct / Math.max(0.01, elapsedPct);
  var dev = ratio - 1; // negative = under, positive = over
  var devPct = Math.round(dev * 100);
  var absDev = Math.abs(dev);

  // Visual length: cap at 1.0 (= 100% deviation) so the bar never
  // overflows. Linear within that range.
  var visMag = Math.min(1, absDev);
  var fillPct = visMag * 50; // half-track in either direction

  // Colour escalates only on the over-pace side; under-pace stays
  // green at any magnitude (slowing down is never alarming).
  var fillColor;
  var numClass;
  if (dev < -0.05) {
    fillColor = colorForPct(35); // mid-green tone, distinguishable from over
    numClass = 'under';
  } else if (dev <= 0.15) {
    fillColor = 'var(--text-2)';
    numClass = '';
  } else if (dev <= 0.5) {
    fillColor = colorForPct(60); // yellow
    numClass = 'warn';
  } else {
    fillColor = colorForPct(95); // red
    numClass = 'bad';
  }

  var fillStyle = '';
  if (dev > 0.005) {
    fillStyle = 'left:50%;width:' + fillPct.toFixed(1) + '%;background:' + fillColor;
  } else if (dev < -0.005) {
    fillStyle = 'right:50%;width:' + fillPct.toFixed(1) + '%;background:' + fillColor;
  }

  var sign = dev > 0 ? '+' : dev < 0 ? '\\u2212' : '\\u00b1';
  var num = sign + Math.abs(devPct) + '%';

  return '<span class="pace-meter">'
    +    '<span class="pace-track">'
    +      '<span class="pace-center"></span>'
    +      (fillStyle ? '<span class="pace-fill" style="' + fillStyle + '"></span>' : '')
    +    '</span>'
    +    '<span class="pace-num ' + numClass + '">' + num + '</span>'
    +  '</span>';
}

function renderDashboard() {
  if (!DATA || !DATA.data) return;
  var raw = DATA.lastGoodData || DATA.data;
  if (raw.apiUnavailable && !DATA.lastGoodData) return;

  // Build dashboard data from cache shape. Labels track the wording on
  // claude.ai/settings/usage so the dashboard and the source of truth
  // speak the same vocabulary.
  var now = Date.now();
  var quotas = [];
  if (raw.fiveHour !== null && raw.fiveHour !== undefined)
    quotas.push({ id: '5h', label: 'Current session', pct: raw.fiveHour,
      resetAt: raw.fiveHourResetAt ? new Date(raw.fiveHourResetAt).getTime() : null, windowMs: FIVE_HOUR_MS });
  if (raw.sevenDay !== null && raw.sevenDay !== undefined)
    quotas.push({ id: '7d', label: 'All models', pct: raw.sevenDay,
      resetAt: raw.sevenDayResetAt ? new Date(raw.sevenDayResetAt).getTime() : null, windowMs: SEVEN_DAY_MS });
  if (raw.sonnet !== null && raw.sonnet !== undefined)
    quotas.push({ id: 'snt', label: 'Sonnet only', pct: raw.sonnet,
      resetAt: raw.sonnetResetAt ? new Date(raw.sonnetResetAt).getTime() : null, windowMs: SEVEN_DAY_MS });
  if (raw.opus !== null && raw.opus !== undefined)
    quotas.push({ id: 'ops', label: 'Opus only', pct: raw.opus,
      resetAt: raw.opusResetAt ? new Date(raw.opusResetAt).getTime() : null, windowMs: SEVEN_DAY_MS });
  if (raw.design !== null && raw.design !== undefined)
    quotas.push({ id: 'dsn', label: 'Claude Design', pct: raw.design,
      resetAt: raw.designResetAt ? new Date(raw.designResetAt).getTime() : null, windowMs: SEVEN_DAY_MS });
  if (raw.routines !== null && raw.routines !== undefined)
    quotas.push({ id: 'rtn', label: 'Claude Routines', pct: raw.routines,
      resetAt: raw.routinesResetAt ? new Date(raw.routinesResetAt).getTime() : null, windowMs: SEVEN_DAY_MS });

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
  // Each card is a two-bar comparison:
  //   QUOTA  [████|░░░░░░░░░░░░░░░░░░░·] 50%   projected end 74%
  //   TIME   [██████████████|░░░░░░░░░·] 68%   resets in 1h 37m
  //                                            Apr 25, 09:40 PM
  //
  // The solid pipe (|) marks "current"; the dotted/dashed pipe (·)
  // marks "estimated end". Same line type means the same conceptual
  // moment ("now" is solid, "end of window" is dashed) on both bars,
  // so the reader can map one to the other without explicit labels.
  // Severity (bar tint + left-edge stripe) takes pace into account so
  // a high projected number under safe pace doesn't trigger a false alarm.
  html += '<div class="cards">';
  for (const q of d.quotas) {
    const pace = calcPace(q.pct, q.resetAt, q.windowMs);
    const projected = pace ? pace.projected : null;
    const elapsedPct = pace ? Math.round(pace.elapsed * 100) : null;
    const paceWord = pace ? pace.paceWord : undefined;

    const cur = Math.max(0, Math.min(100, q.pct));
    const projC = projected == null ? null : Math.max(0, Math.min(100, projected));
    const projTrailEnd = projC != null && projC > cur ? projC : null;

    // Continuous colour ramp: each bar segment takes the colour of the %
    // it represents, so 5% reads as a different green than 25%, which
    // reads as different yellow-green than 60%. Inline styles because
    // every card draws a unique tone — too many to enumerate as classes.
    const fillColor = colorForPct(cur);
    const projFillColor = projTrailEnd != null ? colorForPct(projTrailEnd) : null;
    const stripeColor = concernColor(cur, projC, paceWord);

    // Quota bar: solid fill, dim trail to projected, solid line at
    // current, dashed line at estimated.
    let quotaBar = '<div class="bar">';
    quotaBar += '<div class="bar-fill" style="width:' + cur + '%;background:' + fillColor + '"></div>';
    if (projTrailEnd != null) {
      quotaBar += '<div class="bar-proj" style="left:' + cur
        + '%;width:' + (projTrailEnd - cur) + '%;background:' + projFillColor + '"></div>';
    }
    quotaBar += '<div class="bar-now" style="left:' + cur + '%"></div>';
    if (projC != null) {
      quotaBar += '<div class="bar-end" style="left:' + projC + '%"></div>';
    }
    quotaBar += '</div>';

    // Time bar: solid line at elapsed, dashed line at 100% (= reset).
    // The dashed line on the time bar carries the same "estimated end"
    // semantic as the quota bar's dashed line — both fire at the same
    // moment in time, so the reader can map one to the other.
    let timeBar = '';
    if (elapsedPct != null) {
      timeBar = '<div class="metric">'
        + '<span class="m-label">time</span>'
        + '<div class="bar bar-time">'
        +   '<div class="bar-fill" style="width:' + elapsedPct + '%"></div>'
        +   '<div class="bar-now" style="left:' + elapsedPct + '%"></div>'
        +   '<div class="bar-end" style="left:100%"></div>'
        + '</div>'
        + '<span class="m-value">' + elapsedPct + '<span class="m-unit">%</span></span>'
        + '</div>';
    }

    // Card head right (top-right of quota chart): pace meter — the
    // user's primary "should I slow down?" signal.
    const pmHtml = paceMeter(cur, elapsedPct);

    // Card foot left: projected end %. Right: reset (relative + absolute).
    let footLeft = '';
    if (projected != null) {
      footLeft = '<span class="aside">'
        + '<span class="lbl">projected end</span> '
        + '<span class="v">' + projected + '%</span>'
        + '</span>';
    }
    let footRight = '';
    if (q.resetAt && q.resetAt > d.now) {
      footRight = '<span class="aside stack">'
        +   '<span><span class="lbl">resets in</span> <span class="v">' + fmt(q.resetAt - d.now) + '</span></span>'
        +   '<span class="v-2">' + fmtDate(q.resetAt) + '</span>'
        + '</span>';
    } else if (q.resetAt) {
      footRight = '<span class="aside v-2">window closed</span>';
    }

    let foot;
    if (!timeBar && !q.resetAt) {
      foot = '<div class="card-foot empty">no active window</div>';
    } else {
      foot = '<div class="card-foot">'
        + '<span>' + footLeft + '</span>'
        + '<span>' + footRight + '</span>'
        + '</div>';
    }

    html += '<section class="card" style="--card-color:' + stripeColor + '">'
      + '<div class="card-head">'
      +   '<span class="card-title">' + _esc(q.label) + '</span>'
      +   pmHtml
      + '</div>'
      + '<div class="metric">'
      +   '<span class="m-label">quota</span>'
      +   quotaBar
      +   '<span class="m-value">' + cur + '<span class="m-unit">%</span></span>'
      + '</div>'
      + timeBar
      + foot
      + '</section>';
  }
  html += '</div>';

  // ── Extra usage card ─────────────────────────────────────
  // Mirrors the two-bar quota card: SPEND bar (severity-tinted) +
  // MONTH bar (neutral). Same vertical-line markers ("now" solid,
  // "estimated end" dashed) keep the visual language consistent so a
  // reader doesn't have to learn a second card type.
  if (d.extraUsage && d.extraUsage.enabled !== false) {
    const e = d.extraUsage;
    const monthlyLimit = e.monthlyLimit || 0;
    const used = e.usedCredits || 0;
    const monthlyPct = monthlyLimit > 0 ? Math.min(100, (used / monthlyLimit) * 100) : 0;
    const balance = e.creditGrant != null ? Math.max(0, e.creditGrant - used) : null;

    // Month-elapsed: lets us project month-end spend at the current
    // rate and tint the spend bar accordingly.
    const dt = new Date(d.now);
    const daysInMonth = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    const monthFraction = ((dt.getDate() - 1) + dt.getHours() / 24) / daysInMonth;
    const elapsedPct = Math.round(monthFraction * 100);
    const monthEndAt = new Date(dt.getFullYear(), dt.getMonth() + 1, 1).getTime();

    let projectedPct = null;
    let projectedSpend = null;
    if (monthFraction >= 0.02 && monthlyLimit > 0) {
      projectedSpend = used / monthFraction;
      projectedPct = Math.min(999, Math.round((projectedSpend / monthlyLimit) * 100));
    }
    const paceWord = projectedPct == null ? undefined
      : monthlyPct > elapsedPct + 5 ? 'over'
      : monthlyPct < elapsedPct - 5 ? 'under' : 'on';

    const cur = Math.round(monthlyPct);
    const projC = projectedPct == null ? null : Math.max(0, Math.min(100, projectedPct));
    const projTrailEnd = projC != null && projC > cur ? projC : null;

    const fillColor = colorForPct(cur);
    const projFillColor = projTrailEnd != null ? colorForPct(projTrailEnd) : null;
    const stripeColor = concernColor(cur, projC, paceWord);

    // Spend bar
    let spendBar = '<div class="bar">';
    spendBar += '<div class="bar-fill" style="width:' + cur + '%;background:' + fillColor + '"></div>';
    if (projTrailEnd != null) {
      spendBar += '<div class="bar-proj" style="left:' + cur + '%;width:'
        + (projTrailEnd - cur) + '%;background:' + projFillColor + '"></div>';
    }
    spendBar += '<div class="bar-now" style="left:' + cur + '%"></div>';
    if (projC != null) {
      spendBar += '<div class="bar-end" style="left:' + projC + '%"></div>';
    }
    spendBar += '</div>';

    // Pace meter for the extra-usage card uses spend% vs month%.
    const pmHtml = paceMeter(cur, elapsedPct);

    // Foot left: projected month-end spend ($).
    let footLeft = '';
    if (projectedSpend != null) {
      footLeft = '<span class="aside">'
        + '<span class="lbl">projected end</span> '
        + '<span class="v">' + fmtMoney(projectedSpend) + '</span>'
        + '</span>';
    }
    // Foot right: relative + absolute reset (1st of next month).
    const monthEndMs = monthEndAt - d.now;
    const footRight = '<span class="aside stack">'
      + '<span><span class="lbl">resets in</span> <span class="v">' + fmt(monthEndMs) + '</span></span>'
      + '<span class="v-2">' + fmtDate(monthEndAt) + '</span>'
      + '</span>';

    html += '<section class="card money" style="--card-color:' + stripeColor + '">'
      + '<div class="card-head">'
      +   '<span class="card-title">Extra usage</span>'
      +   pmHtml
      + '</div>'
      + '<div class="metric">'
      +   '<span class="m-label">spend</span>'
      +   spendBar
      +   '<span class="m-value">' + fmtMoney(used) + '</span>'
      + '</div>'
      + '<div class="metric">'
      +   '<span class="m-label">month</span>'
      +   '<div class="bar bar-time">'
      +     '<div class="bar-fill" style="width:' + elapsedPct + '%"></div>'
      +     '<div class="bar-now" style="left:' + elapsedPct + '%"></div>'
      +     '<div class="bar-end" style="left:100%"></div>'
      +   '</div>'
      +   '<span class="m-value">' + elapsedPct + '<span class="m-unit">%</span></span>'
      + '</div>'
      + '<div class="card-foot">'
      +   '<span>' + footLeft + '</span>'
      +   '<span>' + footRight + '</span>'
      + '</div>'
      + '<div class="ms-summary">'
      +   '<span class="item"><span class="lbl">limit</span><span class="v">' + fmtMoney(monthlyLimit) + '</span></span>'
      +   (balance != null
            ? '<span class="item"><span class="lbl">balance</span><span class="v">' + fmtMoney(balance) + '</span><span class="v-2"> of ' + fmtMoney(e.creditGrant) + ' grant</span></span>'
            : '')
      + '</div>'
      + '</section>';
  }

  // ── Footer: single line, mono, dim. Both representations of the
  // fetch time so the reader can correlate "12s ago" with a clock. ──
  html += '<footer>fetched ' + new Date(d.fetchedAt).toLocaleString()
    + ' \\u00b7 ' + agoStr + '</footer>';

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
