import type { StdinData, UsageData, GitStatus } from './types.js';
import { getModelName, getContextPercent, getProjectName, getEffortLevel } from './stdin.js';
import { visibleLength, truncate, hyperlink } from './ansi.js';
import { dashboardFileUrl } from './paths.js';
import { warn } from '@mmdemirbas/claude-usage';

// ── String coercion ───────────────────────────────────────────────────────
//
// JSON-deserialised inputs (stdin from Claude Code, cached UsageData on
// disk) cannot be trusted to match their type annotations: a future
// schema change or hostile cache file may put `{level: 'high'}` where a
// string was promised, and `.toLowerCase()` then throws inside the
// renderer. asString collapses every non-string value to '' so call
// sites can chain string methods without guarding individually.

/** Coerce arbitrary value to string; returns '' for null/undefined/non-string. */
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

// ── ANSI colors ────────────────────────────────────────────────────────────

const R = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const B_CYAN = '\x1b[96m';
const B_BLUE = '\x1b[94m';
const B_MAG = '\x1b[95m';
const BAR_WASTE = '\x1b[38;5;250m'; // slightly dimmer — wasted quota in bars

const c = (color: string, text: string) => `${color}${text}${R}`;
const dim = (text: string) => c(DIM, text);

/** Produce a darker variant of an ANSI color via DIM attribute. */
const darken = (color: string): string => `${DIM}${color}`;

// ── Model name display ─────────────────────────────────────────────────────

function extractFamily(displayName: unknown): string {
  const raw = asString(displayName);
  if (!raw) return 'claude';
  const s = raw.replace(/^Claude\s+/i, '').trim();
  // "Family Major.Minor"  e.g. "Sonnet 4.6"
  let m = s.match(/^(\w+)\s+\d+\.\d+$/);
  if (m) return m[1].toLowerCase();
  // "Major.Minor Family"  e.g. "3.5 Sonnet"
  m = s.match(/^\d+\.\d+\s+(\w+)$/);
  if (m) return m[1].toLowerCase();
  // fallback: first word
  return (s.split(/\s+/)[0] ?? s).toLowerCase();
}

/**
 * Format the model line as "family effort" (e.g. "sonnet high").
 * Falls back to just the family name when effort is absent.
 * Exported for testing.
 *
 * Both arguments are typed `unknown` because callers receive them from
 * JSON-deserialised stdin, where Claude Code on Windows has been seen
 * passing a non-string `effort`. Coercing here keeps the renderer safe
 * even if a future stdin getter forgets to narrow.
 */
export function modelDisplay(displayName: unknown, effort: unknown): string {
  const family = extractFamily(displayName);
  const e = asString(effort);
  return e ? `${family} ${e.toLowerCase()}` : family;
}

// ── Color by severity ──────────────────────────────────────────────────────

function ctxColor(pct: number): string {
  if (pct >= 85) return RED;
  if (pct >= 70) return YELLOW;
  return GREEN;
}

function quotaColor(pct: number): string {
  if (pct >= 90) return RED;
  if (pct >= 75) return B_MAG;
  return B_BLUE;
}

function projectedColor(proj: number): string {
  if (proj > 100) return RED;
  if (proj >= 80) return YELLOW;
  return DIM;
}

/** Color for the filled chars in a money bar. */
function moneyBarColor(pct: number): string {
  if (pct >= 80) return RED;
  if (pct > 0)   return YELLOW;
  return DIM;
}

/** Color for the current-spend text. */
function moneyValueColor(ratio: number): string {
  if (ratio >= 0.8) return RED;
  if (ratio > 0)    return YELLOW;
  return GREEN;
}

// ── Bars ────────────────────────────────────────────────────────────────────

/**
 * Render a progress bar of `width` block characters.
 *
 * Visual layers (left to right):
 *   1. Dim fill █ — consumed quota up to pace, darkened severity color
 *   2. Bright fill █ — over-consumed portion (ideal → current), full severity color
 *   3. Projected ░ — expected future consumption, dim (or red when projected ≥ 100%)
 *   4. Wasted ░ — quota that won't be used, gray
 *
 * Exported for testing.
 */
export function bar(pct: number, width: number, colorFn: (p: number) => string, projectedPct?: number, elapsedFraction?: number): string {
  const safe = Math.max(0, Math.min(100, pct));
  const filled = Math.round((safe / 100) * width);
  const empty = width - filled;

  if (projectedPct === undefined) {
    return `${colorFn(safe)}${'█'.repeat(filled)}${colorFn(safe)}${'░'.repeat(empty)}${R}`;
  }

  const color = colorFn(safe);

  if (elapsedFraction === undefined) {
    // No pace info — original projected coloring
    if (projectedPct >= 100) {
      return `${color}${'█'.repeat(filled)}${RED}${'░'.repeat(empty)}${R}`;
    }
    const projFilled = Math.min(width, Math.round((projectedPct / 100) * width));
    const projPath = Math.max(0, projFilled - filled);
    const wasted = empty - projPath;
    return `${color}${'█'.repeat(filled)}${color}${'░'.repeat(projPath)}${BAR_WASTE}${'░'.repeat(wasted)}${R}`;
  }

  const idealPos = Math.round(elapsedFraction * width);
  const isOverPace = filled > idealPos;
  const projPos = Math.min(width, Math.round((Math.min(projectedPct, 100) / 100) * width));
  const projPart = Math.max(0, projPos - filled);
  const grayPart = width - filled - projPart;
  const projColor = projectedPct >= 100 ? RED : color;

  if (isOverPace) {
    // Over-pace: dim up to ideal, bright over-consumed, projected, wasted
    const normalFill = idealPos;
    const overFill = filled - normalFill;
    return `${darken(color)}${'█'.repeat(normalFill)}${R}${color}${'█'.repeat(overFill)}${R}${projColor}${'░'.repeat(projPart)}${R}${BAR_WASTE}${'░'.repeat(grayPart)}${R}`;
  }

  // Under-pace: all filled is "up to pace" (dim), projected, wasted
  return `${darken(color)}${'█'.repeat(filled)}${R}${projColor}${'░'.repeat(projPart)}${R}${BAR_WASTE}${'░'.repeat(grayPart)}${R}`;
}

// ── Time formatting ────────────────────────────────────────────────────────

/** Exported for testing. */
export function resetIn(resetAt: Date | null, now: number): string {
  if (!resetAt) return '';
  const t = resetAt.getTime();
  // Defense in depth: usage.ts hydrateDates already drops Invalid Date,
  // but a malformed Date here would otherwise produce "NaNm"/"NaNh".
  if (isNaN(t)) return '';
  const diffMs = t - now;
  if (diffMs <= 0) return '';

  const mins = Math.ceil(diffMs / 60000);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    // The bare days form was the one path out of here with no width bound. A
    // quota window resets within seven days, so a larger number means a
    // corrupted or misparsed date rather than a long wait — and `2913770d`
    // pushed every field after it off the line. Say "more than 99 days" in
    // four columns instead, which is both true and inside the slot.
    if (days > 99) return '99d+';
    const remH = hours % 24;
    if (remH > 0) {
      const full = `${days}d${remH}h`;
      return full.length <= 5 ? full : `${days}d`; // drop hours if they don't fit
    }
    return `${days}d`;
  }

  if (remMins > 0) {
    const full = `${hours}h${remMins}m`;
    return full.length <= 5 ? full : `${hours}h`; // drop minutes if they don't fit
  }
  return `${hours}h`;
}

/**
 * Does this reading carry anything worth drawing?
 *
 * The gate used to be `!usage.apiUnavailable`, which is a claim *about* the
 * data rather than the data itself — and the two came apart. A failure that
 * still carries last-good numbers sets the flag, and so does any reading whose
 * `error` is set, whatever its buckets hold. Every quota was then dropped and a
 * bare ⚠ printed in place of a full display.
 *
 * Asking the numbers directly cannot come apart from them. `apiStatusHint`
 * already renders the failure glyph independently, so nothing is lost by no
 * longer consulting the flag here.
 */
function hasQuotaNumbers(usage: UsageData | null | undefined): usage is UsageData {
  if (!usage) return false;
  return [usage.fiveHour, usage.sevenDay, usage.sonnet, usage.opus,
    usage.design, usage.routines, usage.code].some((v) => v !== null && v !== undefined)
    || !!usage.extraUsage?.enabled;
}

/** Format fetch timestamp as ⟳HH:MM (local time). Exported for testing. */
export function formatFetchTime(fetchedAt: number, now: number = Date.now()): string {
  const d = new Date(fetchedAt);
  // `resetIn` guards this and this one did not. coerceReading only requires a
  // finite number, so anything past Date's range yields "⟳NaN:NaN" — eight
  // visible chars in a six-wide slot, which shifts the whole line right.
  if (isNaN(d.getTime())) return '⟳--:--';

  const ageMs = now - fetchedAt;
  // HH:MM alone stopped being unambiguous when the displayed reading could be
  // old: during a backoff it is the last *successful* measurement, up to a day
  // back, and "⟳09:00" reads as this morning either way. Past twelve hours,
  // show the age instead — the point of the stamp is how stale the numbers are.
  if (ageMs >= 12 * 60 * 60_000) {
    const days = Math.floor(ageMs / (24 * 60 * 60_000));
    if (days >= 1) return `⟳${Math.min(days, 99)}d+`;
    return `⟳${Math.floor(ageMs / (60 * 60_000))}h+`;
  }

  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `⟳${h}:${m}`;
}

// ── Pace calculation ────────────────────────────────────────────────────────

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

export interface PaceResult {
  projected: number;
  /** Fraction of the window elapsed (0–1). */
  elapsed: number;
  /** ↘ under pace · → on pace · ↗ over pace */
  glyph: string;
  glyphColor: string;
}

/**
 * Calculate pace and projected end-of-window utilization.
 * Returns null when there is too little elapsed time (< 2% of the window).
 * Exported for testing.
 */
export function calcPace(
  pct: number,
  resetAt: Date | null,
  windowMs: number,
  now: number,
): PaceResult | null {
  if (!resetAt) return null;
  const t = resetAt.getTime();
  if (isNaN(t)) return null;
  const remaining = t - now;
  if (remaining <= 0 || remaining >= windowMs) return null;
  const elapsedFraction = (windowMs - remaining) / windowMs;
  if (elapsedFraction < 0.02) return null;

  const projected = Math.round(pct / elapsedFraction);
  // paceRatio > 1 means burning faster than expected
  const paceRatio = pct / (elapsedFraction * 100);

  let glyph: string;
  let glyphColor: string;
  if (paceRatio < 0.85) {
    glyph = '↘'; glyphColor = GREEN;
  } else if (paceRatio <= 1.15) {
    glyph = '→'; glyphColor = DIM;
  } else {
    glyph = '↗'; glyphColor = projected > 100 ? RED : YELLOW;
  }

  return { projected, elapsed: elapsedFraction, glyph, glyphColor };
}

/**
 * Return a filled-circle glyph showing how far into the quota window we are.
 *   ○ 0–20%  ◔ 20–40%  ◑ 40–60%  ◕ 60–80%  ● 80–100%
 * Exported for testing.
 */
export function windowGlyph(resetAt: Date | null, windowMs: number, now: number): string {
  if (!resetAt) return '○';
  const t = resetAt.getTime();
  if (isNaN(t)) return '○';
  const remaining = t - now;
  if (remaining <= 0) return '●';
  if (remaining >= windowMs) return '○';
  const elapsedFraction = (windowMs - remaining) / windowMs;
  return ['○', '◔', '◑', '◕', '●'][Math.min(4, Math.floor(elapsedFraction * 5))];
}

/** Day-of-month elapsed fraction for monthly spend pace. */
function monthElapsedFraction(now: number): number {
  const d = new Date(now);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const elapsed = (d.getDate() - 1) + d.getHours() / 24 + d.getMinutes() / (24 * 60);
  return elapsed / daysInMonth;
}

// ── Detail levels ──────────────────────────────────────────────────────────

/**
 * Controls how much information is shown in each quota segment and in the
 * git portion of line 1. Tiers are tried in order until the line fits within
 * the available terminal width.
 *
 * Quota segment visible widths per tier:
 *   full:      label(4) + bar(10) + sp(1) + pct(4) + pace(6) + reset(7) = 32
 *   no-reset:  label(4) + bar(10) + sp(1) + pct(4) + pace(6)            = 25
 *   no-pace:   label(4) + bar(10) + sp(1) + pct(4)                      = 19
 *   compact:   label(4) + sp(1)   + pct(4)                              =  9
 *
 * Line-1 git degradation:
 *   full / no-reset:  project + git:(branch[*])
 *   no-pace:          project only
 *   compact:          omit git entirely
 */
export type DetailLevel = 'full' | 'no-reset' | 'no-pace' | 'compact';
const DETAIL_LEVELS: DetailLevel[] = ['full', 'no-reset', 'no-pace', 'compact'];

/**
 * Per-tier visible width of a quota segment — the widths renderQuota produces
 * from its own label, bar, percentage, pace and reset slots.
 *
 * A declared expectation, not the value the layout is built from: nothing in
 * this file reads it any more, so editing a number here changes what the tests
 * demand and not one column of what is drawn. That makes it useful in exactly
 * one direction. A layout change that shifts a segment's width fails the tests
 * comparing against it, which is the point — but the fix is to change the
 * layout and then this, in that order.
 *
 * (It had one source consumer: the disabled extra-usage placeholder padded
 * itself to these widths. That segment is last on every line it appears on, so
 * the padding only ever ran off the end, and it is gone.)
 */
export const TIER_SEGMENT_WIDTH: Record<DetailLevel, number> = {
  full: 32,
  'no-reset': 25,
  'no-pace': 19,
  compact: 9,
};

// ── Adaptive line builder ──────────────────────────────────────────────────

const SEP = dim(' │ '); // 3 visible chars

/**
 * Build a console line by trying each detail level in order.
 * Returns the first rendering whose visible length fits within maxCols,
 * or the compact rendering hard-truncated to maxCols as a final safety net.
 */
function fitLine(
  buildParts: (detail: DetailLevel) => (string | null)[],
  maxCols: number,
): string {
  for (const detail of DETAIL_LEVELS) {
    const parts = buildParts(detail).filter((p): p is string => p !== null);
    if (parts.length === 0) return '';
    const line = dropTrailingPad(parts.join(SEP));
    if (visibleLength(line) <= maxCols) return line;
  }
  // Safety net: hard truncate the compact rendering
  const parts = buildParts('compact').filter((p): p is string => p !== null);
  return truncate(dropTrailingPad(parts.join(SEP)), maxCols);
}

/**
 * Drop padding that runs off the end of a line.
 *
 * Segments pad themselves to their tier width so the columns line up between
 * rows, which is right for every segment except the last one: there is nothing
 * to its right to align with. The disabled extra-usage placeholder is nine
 * columns of content padded to thirty-two, so it ended each line with
 * twenty-three spaces. They are invisible, but they are not free — the line
 * measured seventy-seven columns wide when it drew fifty-four, so `fitLine`
 * dropped to a narrower tier on any terminal between those two widths, hiding
 * reset times that fit perfectly well.
 */
function dropTrailingPad(line: string): string {
  return line.replace(/ +$/, '');
}

// ── Segment rendering ──────────────────────────────────────────────────────

/**
 * Clickable dashboard link. Renders as the literal text "dashboard"
 * wrapped in an OSC 8 hyperlink that opens
 * ~/.claude/plugins/claude-quota/dashboard.html. Terminals without OSC 8
 * support strip the frame and just show the word — still informative
 * (users can `! open ~/.claude/plugins/claude-quota/dashboard.html`).
 *
 * Visible width is the text length plus the leading space supplied by
 * the caller (" dashboard" = 10 columns). Attached to the ctx segment
 * so it's visible on every layout height; tier-dropped at the compact
 * width so very narrow terminals can keep the percentage visible.
 */
const DASH_LINK_TEXT = 'dashboard';
function dashLink(): string {
  return `${BOLD}${B_CYAN}${hyperlink(DASH_LINK_TEXT, dashboardFileUrl())}${R}`;
}

/**
 * Single source of truth for the API-status hint glyph and its
 * with-leading-space variant, used everywhere the status surfaces:
 *   - rows=1 right edge (compact path)
 *   - rows≥2 syncHint slot (right edge of line 2/3 quotas)
 *   - the standalone apiUnavailable line (no quotas to share with)
 *
 * `padded` is "<sep><glyph>" (visible width 2) for the right-edge
 * hint slot; `glyph` alone is for the standalone line. Both use
 * the same color so the three presentations stay in lockstep.
 *
 * Returns empty strings + width 0 when usage is healthy.
 */
function apiStatusHint(usage: UsageData | null): { glyph: string; padded: string; width: number } {
  if (usage?.apiError === 'rate-limited') {
    const padded = dim(' ⟳');
    return { glyph: dim('⟳'), padded, width: visibleLength(padded) };
  }
  if (usage?.apiUnavailable) {
    const padded = c(YELLOW, ' ⚠');
    return { glyph: c(YELLOW, '⚠'), padded, width: visibleLength(padded) };
  }
  return { glyph: '', padded: '', width: 0 };
}

/**
 * Render the git portion of line 1.
 * Returns null when project is absent or detail is 'compact'.
 */
function renderGit(
  project: string | null,
  git: GitStatus | null,
  detail: DetailLevel,
): string | null {
  if (!project || detail === 'compact') return null;
  let part = c(YELLOW, project);
  if (git && detail !== 'no-pace') {
    const branchStr = git.branch + (git.isDirty ? '*' : '');
    part += ` ${c(MAGENTA, 'git:(')}${c(CYAN, branchStr)}${c(MAGENTA, ')')}`;
  }
  return part;
}

/**
 * Render a quota metric segment.
 * Visible widths by tier — see DetailLevel comment for the breakdown.
 * label must be exactly 4 visible chars (e.g. " 5h:", "snt:").
 */
function renderQuota(
  label: string,
  pct: number | null,
  resetAt: Date | null,
  windowMs: number,
  now: number,
  detail: DetailLevel,
): string | null {
  if (pct === null) return null;

  // pct: right-justify in 4 chars → " 17%", "100%"
  const pctStr = `${pct}%`.padStart(4);

  if (detail === 'compact') {
    return `${dim(label)} ${quotaColor(pct)}${pctStr}${R}`;
  }

  // Compute pace early so projected% can colour the bar even in no-pace tier
  const pace = calcPace(pct, resetAt, windowMs, now);
  const b = bar(pct, 10, quotaColor, pace?.projected, pace?.elapsed);

  if (detail === 'no-pace') {
    return `${dim(label)}${b} ${quotaColor(pct)}${pctStr}${R}`;
  }

  // pace: 1(space) + 1(glyph) + 4(proj padded) = 6 chars, or 6 spaces
  let paceStr: string;
  if (pace) {
    const projStr = `${Math.min(pace.projected, 999)}%`.padStart(4);
    paceStr = ` ${pace.glyphColor}${pace.glyph}${R}${projectedColor(pace.projected)}${projStr}${R}`;
  } else {
    paceStr = '      '; // 6 spaces
  }

  if (detail === 'no-reset') {
    return `${dim(label)}${b} ${quotaColor(pct)}${pctStr}${R}${paceStr}`;
  }

  // full: add reset (1(space) + up to 6(glyph+time padded to 6) = 7 chars)
  const reset = resetIn(resetAt, now);
  let resetStr: string;
  if (reset) {
    const glyph = windowGlyph(resetAt, windowMs, now);
    const resetPad = `${glyph}${reset}`.padEnd(6);
    resetStr = ` ${dim(resetPad)}`;
  } else {
    resetStr = '       '; // 7 spaces
  }

  return `${dim(label)}${b} ${quotaColor(pct)}${pctStr}${R}${paceStr}${resetStr}`;
}

/**
 * Format a dollar amount to at most 4 visible chars, for use with padStart(4).
 * - $0          → "$0"    (2 chars)
 * - $0.01–$0.99 → "$.XX"  (4 chars, preserves cent precision)
 * - $1–$999     → "$NNN"  (2–4 chars)
 * - $1000+      → "$Nk"   (3–4 chars)
 * Exported for testing.
 */
export function formatMoney(amount: number): string {
  if (amount === 0) return '$0';
  // Math.round can carry 0.995+ up to 100, which renders as "$.100" — five
  // chars where the layout above promises four, overflowing the segment and
  // swallowing the space before the pace glyph. Reachable through
  // projectedSpend, which is an arbitrary real. Anything that rounds to a whole
  // dollar is a whole dollar.
  if (amount < 1) {
    const cents = Math.round(amount * 100);
    if (cents >= 100) return '$1';
    return `$.${cents.toString().padStart(2, '0')}`;
  }
  if (amount < 1000) return `$${Math.round(amount)}`;
  const k = Math.round(amount / 1000);
  return `$${k}k`;
}

/**
 * Format balance (creditGrant - usedCredits) for display.
 * Shows two decimal places for amounts under $100, otherwise uses formatMoney.
 * Exported for testing.
 */
export function formatBalance(creditGrant: number, usedCredits: number): string {
  const balance = Math.max(0, creditGrant - usedCredits);
  if (balance === 0) return '$0';
  if (balance < 10) {
    const rounded = Math.round(balance * 100) / 100;
    return `$${rounded.toFixed(2)}`;
  }
  if (balance < 100) {
    return `$${Math.round(balance)}`;
  }
  return formatMoney(balance);
}

/**
 * Render the extra (pay-as-you-go) usage segment.
 * Same tier widths as renderQuota; 'reset' slot holds the monthly limit instead.
 *
 * The disabled state renders its nine columns and stops. It used to pad out to
 * the active tier's width for grid alignment, but this segment is last on
 * every line that carries it, so the padding only ever ran off the end — and
 * counted against the width budget while doing so. Alignment of the segments
 * that *do* have neighbours is set by those neighbours' own widths;
 * `dropTrailingPad` in fitLine removes what overhangs the end.
 */
function renderExtraUsage(usage: UsageData, now: number, detail: DetailLevel): string | null {
  if (!usage.extraUsage) return null;
  if (!usage.extraUsage.enabled) {
    return `${dim(' ○$:')} ${dim(' off')}`;
  }

  const { usedCredits, monthlyLimit, creditGrant } = usage.extraUsage;
  const usedPct = Math.min(100, Math.round((usedCredits / monthlyLimit) * 100));
  const ratio = usedCredits / monthlyLimit;

  // Balance suffix: " ($XX.XX)" when credit grant is known
  const balStr = creditGrant !== null
    ? ` ${dim('(')}${GREEN}${formatBalance(creditGrant, usedCredits)}${R}${dim(')')}`
    : '';

  // value: right-justified in 4 chars (matches pct field in renderQuota)
  const valueStr = formatMoney(usedCredits).padStart(4);

  if (detail === 'compact') {
    return `${dim(' ●$:')} ${moneyValueColor(ratio)}${valueStr}${R}${balStr}`;
  }

  // Compute pace early so projected% can colour the bar even in no-pace tier
  const elapsedFraction = monthElapsedFraction(now);
  const projectedSpend = elapsedFraction >= 0.02 ? usedCredits / elapsedFraction : undefined;
  const projectedMoneyPct = projectedSpend !== undefined
    ? Math.round((projectedSpend / monthlyLimit) * 100)
    : undefined;
  const b = bar(usedPct, 10, moneyBarColor, projectedMoneyPct, elapsedFraction >= 0.02 ? elapsedFraction : undefined);

  if (detail === 'no-pace') {
    return `${dim(' ●$:')}${b} ${moneyValueColor(ratio)}${valueStr}${R}${balStr}`;
  }

  // pace: 1(space) + 1(glyph) + 4(projected padded) = 6 chars, or 6 spaces
  let paceStr: string;
  if (projectedSpend !== undefined) {
    const paceRatio = ratio / elapsedFraction;
    const projRatio = projectedSpend / monthlyLimit;

    let glyph: string, glyphColor: string;
    if (paceRatio < 0.85) {
      glyph = '↘'; glyphColor = GREEN;
    } else if (paceRatio <= 1.15) {
      glyph = '→'; glyphColor = DIM;
    } else {
      glyph = '↗'; glyphColor = projRatio > 1 ? RED : YELLOW;
    }

    const projColor = projRatio > 1 ? RED : projRatio >= 0.8 ? YELLOW : DIM;
    const projStr = formatMoney(projectedSpend).padStart(4);
    paceStr = ` ${glyphColor}${glyph}${R}${projColor}${projStr}${R}`;
  } else {
    paceStr = '      '; // 6 spaces
  }

  if (detail === 'no-reset') {
    return `${dim(' ●$:')}${b} ${moneyValueColor(ratio)}${valueStr}${R}${paceStr}${balStr}`;
  }

  // full: add monthly limit (matches reset slot in renderQuota)
  const limitPad = `/${formatMoney(monthlyLimit)}`.padEnd(6);
  const limitStr = ` ${dim(limitPad)}`;

  return `${dim(' ●$:')}${b} ${moneyValueColor(ratio)}${valueStr}${R}${paceStr}${limitStr}${balStr}`;
}

// ── Main render ────────────────────────────────────────────────────────────

export interface RenderInput {
  stdin: StdinData;
  usage: UsageData | null;
  git: GitStatus | null;
  /** Override current timestamp (ms). Used in tests for determinism. */
  now?: number;
  /** Terminal width in columns. Defaults to 120. */
  columns?: number;
  /** Terminal height in rows (capped at 3). Defaults to 3. */
  rows?: number;
}

/**
 * Per-line safety net: build and emit one statusline row inside a
 * try/catch. A throw inside one segment (a future schema drift, a
 * stale on-disk cache, a Windows-specific quirk) does not blank the
 * other rows — the failing row is dropped silently and a single warn
 * lands on stderr so debugging is still possible. The outer try/catch
 * in index.ts main() handles plumbing failures that occur before any
 * row gets a chance to build.
 */
function safeEmit(label: string, build: () => string | null): void {
  let line: string | null;
  try {
    line = build();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn('render row failed', { row: label, err: msg });
    return;
  }
  if (line !== null) console.log(line);
}

export function render(input: RenderInput): void {
  const { stdin, usage, git } = input;
  const now = input.now ?? Date.now();
  const cols = input.columns ?? 120;
  const rows = Math.min(input.rows ?? 3, 3);

  // ── Column-0 width: pad model and plan to the same width so bars align ─────
  // Only relevant when rows ≥ 2 (multi-line output).
  const modelText = modelDisplay(getModelName(stdin), getEffortLevel(stdin));
  // planName comes from the on-disk cache (JSON) and the credentials parser;
  // both typed string but historically tolerant of weird subscriptionType
  // values. Coerce defensively so a stale cache cannot crash the render.
  const planText  = asString(usage?.planName).toLowerCase();
  // col0Width clamps the fetch-time stamp ("⟳HH:MM" = 6) and the plan
  // name so line 2/3 prefixes line up with the model name on line 1.
  // The dashboard link no longer sits in col-0 — it travels with the
  // ctx segment so it's adjacent to the chart it links to.
  const FETCH_TIME_WIDTH = 6;
  const col0Width = Math.max(modelText.length, planText.length, FETCH_TIME_WIDTH);

  // Pad visible text to col0Width; ANSI color wraps the unpadded text, spaces follow.
  const pad0 = (text: string, color: string) =>
    `${color}${text}${R}${' '.repeat(Math.max(0, col0Width - text.length))}`;

  // ── Line 1 ────────────────────────────────────────────────────────────────
  const ctxPct = getContextPercent(stdin);
  const ctxPctStr = `${ctxPct}%`.padStart(4);
  const project = getProjectName(stdin);

  // The dashboard link follows the ctx segment — adjacent to the chart
  // it links to. " dashboard" = 10 visible chars. Dropped at the compact
  // tier so very narrow terminals can keep the percentage instead.
  const link = ` ${dashLink()}`;
  const linkSuffix = (detail: DetailLevel): string => (detail === 'compact' ? '' : link);

  const status = apiStatusHint(usage ?? null);

  safeEmit('line1', () => {
    let line1: string;
    if (rows === 1) {
      // Single-row mode: model + compact ctx (+ link) + compact 5h + compact 7d
      // when usage is available. Bars omitted; compact (label + pct) format
      // throughout. Git info is dropped in favour of quota percentages.
      // The rate-limit / API-down hint is appended on the right so the
      // user sees the same status indicator they'd see at rows=3.
      // Link is appended to ctx so truncation drops it last (after the
      // 5h/7d quotas), keeping it visible on typical-width terminals.
      const ctxCompact = `${dim('ctx:')} ${ctxColor(ctxPct)}${ctxPctStr}${R}${link}`;
      const showQuotas = hasQuotaNumbers(usage);
      const parts: (string | null)[] = [
        c(CYAN, modelText),
        ctxCompact,
        showQuotas ? renderQuota(' 5h:', usage.fiveHour, usage.fiveHourResetAt, FIVE_HOUR_MS, now, 'compact') : null,
        showQuotas ? renderQuota(' 7d:', usage.sevenDay, usage.sevenDayResetAt, SEVEN_DAY_MS, now, 'compact') : null,
      ];
      line1 = truncate(
        parts.filter((p): p is string => p !== null).join(SEP),
        cols - status.width,
      ) + status.padded;
    } else {
      // Multi-row mode: model + ctx bar (+ link) + project/git.
      // Git degrades via detail tiers; the link rides along with ctx
      // and is dropped at compact tier (narrowest terminals).
      const ctxBar = bar(ctxPct, 10, ctxColor);
      const ctxBase = `${dim('ctx:')}${ctxBar} ${ctxColor(ctxPct)}${ctxPctStr}${R}`;
      const modelPrefix = `${CYAN}${modelText}${R}`
        + ' '.repeat(Math.max(0, col0Width - modelText.length));
      line1 = fitLine(
        (detail) => [
          modelPrefix,
          `${ctxBase}${linkSuffix(detail)}`,
          renderGit(project, git, detail),
        ],
        cols,
      );
    }
    return `${R}${line1}`;
  });

  if (rows < 2) return;

  // ── Lines 2 & 3: account ──────────────────────────────────────────────────
  // rows=2 layout:  plan │ 5h │ 7d │ snt │ ops │ $  (all quotas on one line)
  // rows≥3 layout:
  //   Line 2: plan │  5h bar pct% pace reset │ snt bar pct% pace reset
  //   Line 3: time │  7d bar pct% pace reset │  ●$ bar val  pace limit

  if (usage && hasQuotaNumbers(usage)) {
    // syncHint slot at the right edge of line 2/3. Any failure kind can reach
    // this branch now — a reading that still carries numbers is drawn whatever
    // went wrong with the most recent refresh — and apiStatusHint is the single
    // source of truth for which glyph says so.
    const syncHint = status.padded;
    const syncW = status.width;

    if (rows === 2) {
      // Flatten all quotas onto a single line.
      const hasContent =
        usage.fiveHour !== null || usage.sevenDay !== null ||
        usage.sonnet !== null || usage.opus !== null ||
        usage.extraUsage !== null || !!planText;
      if (hasContent) {
        safeEmit('line2-flat', () => {
          const line2 = fitLine(
            (detail) => [
              planText ? pad0(planText, CYAN) : null,
              renderQuota(' 5h:', usage.fiveHour, usage.fiveHourResetAt, FIVE_HOUR_MS, now, detail),
              renderQuota(' 7d:', usage.sevenDay, usage.sevenDayResetAt, SEVEN_DAY_MS, now, detail),
              renderQuota('snt:', usage.sonnet, usage.sonnetResetAt, SEVEN_DAY_MS, now, detail),
              renderQuota('ops:', usage.opus, usage.opusResetAt, SEVEN_DAY_MS, now, detail),
              renderExtraUsage(usage, now, detail),
            ],
            cols - syncW,
          );
          return `${R}${line2}${syncHint}`;
        });
      } else if (status.glyph) {
        safeEmit('line2-glyph', () => `${R}${status.glyph}`);
      }
    } else {
      // rows ≥ 3: standard two-account-line layout.
      // hasLine3 is needed before line 2 is built so we know where syncHint lands.
      const hasLine3 = usage.sevenDay !== null || usage.opus !== null || usage.extraUsage !== null;
      const line2HasContent = usage.fiveHour !== null || usage.sonnet !== null || !!planText;
      if (line2HasContent) {
        // syncHint goes on line 2 only when there is no line 3.
        safeEmit('line2', () => {
          const line2 = fitLine(
            (detail) => [
              planText ? pad0(planText, CYAN) : null,
              renderQuota(' 5h:', usage.fiveHour, usage.fiveHourResetAt, FIVE_HOUR_MS, now, detail),
              renderQuota('snt:', usage.sonnet, usage.sonnetResetAt, SEVEN_DAY_MS, now, detail),
            ],
            cols - (hasLine3 ? 0 : syncW),
          );
          return `${R}${line2}${hasLine3 ? '' : syncHint}`;
        });
      }

      if (hasLine3) {
        safeEmit('line3', () => {
          const col0Str = (planText && usage.fetchedAt)
            ? pad0(formatFetchTime(usage.fetchedAt), DIM)
            : ' '.repeat(col0Width);
          const line3 = fitLine(
            (detail) => [
              planText ? col0Str : null,
              renderQuota(' 7d:', usage.sevenDay, usage.sevenDayResetAt, SEVEN_DAY_MS, now, detail),
              renderQuota('ops:', usage.opus, usage.opusResetAt, SEVEN_DAY_MS, now, detail),
              renderExtraUsage(usage, now, detail),
            ],
            cols - syncW,
          );
          return `${R}${line3}${syncHint}`;
        });
      } else if (!planText && !line2HasContent && status.glyph) {
        safeEmit('line2-glyph', () => `${R}${status.glyph}`);
      }
    }
  } else if (status.glyph) {
    // Nothing to draw but something to say: a failure with no numbers behind
    // it. The condition is the glyph rather than `apiUnavailable`, because the
    // branch above is now gated on whether numbers exist, and those two facts
    // are not the same one.
    //
    // Truncated like every other emit path. Built directly, this line ignored
    // the width budget entirely and wrapped onto a row Claude Code had not
    // allocated.
    safeEmit('line2-status', () => {
      const body = planText
        ? `${c(CYAN, planText)}${dim(' │ ')}${status.glyph}`
        : `${status.glyph}`;
      return `${R}${truncate(body, cols)}`;
    });
  } else if (planText) {
    safeEmit('line2-plan', () => `${R}${c(CYAN, planText)}`);
  }
}
