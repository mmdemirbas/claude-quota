import type { StdinData, UsageData, GitStatus } from './types.js';
import { getModelName, getContextPercent, getProjectName, getEffortLevel } from './stdin.js';
import { visibleLength, truncate, hyperlink } from './ansi.js';
import { dashboardFileUrl } from './paths.js';

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

function extractFamily(displayName: string): string {
  const s = displayName.replace(/^Claude\s+/i, '').trim();
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
 */
export function modelDisplay(displayName: string, effort: string | null | undefined): string {
  const family = extractFamily(displayName);
  return effort ? `${family} ${effort.toLowerCase()}` : family;
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

/** Format fetch timestamp as ⟳HH:MM (local time). Exported for testing. */
export function formatFetchTime(fetchedAt: number): string {
  const d = new Date(fetchedAt);
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
 * Per-tier visible width of a quota / extra-usage segment.
 * Exported so tests don't have to hand-mirror the same literals — the
 * source of truth lives here, and a layout change updates every test
 * that derives its boundaries from these widths in lockstep.
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
    const line = parts.join(SEP);
    if (visibleLength(line) <= maxCols) return line;
  }
  // Safety net: hard truncate the compact rendering
  const parts = buildParts('compact').filter((p): p is string => p !== null);
  return truncate(parts.join(SEP), maxCols);
}

// ── Segment rendering ──────────────────────────────────────────────────────

/**
 * Clickable dashboard link. Renders as a single bold-cyan glyph wrapped
 * in an OSC 8 hyperlink that opens ~/.claude/plugins/claude-quota/dashboard.html.
 * Terminals without OSC 8 support strip the frame and just show the glyph.
 *
 * No longer rendered as a fitLine segment — pinning it to the model
 * prefix in `render()` means it survives every width-degradation tier
 * down to compact, instead of being the first thing dropped.
 *
 * Visible width is exactly 1 column (the glyph itself); the leading
 * space is supplied by the caller.
 */
function dashLinkGlyph(): string {
  return `${BOLD}${B_CYAN}${hyperlink('⧉', dashboardFileUrl())}${R}`;
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
  if (amount < 1)   return `$.${Math.round(amount * 100).toString().padStart(2, '0')}`;
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
 * The disabled state pads to the same compact-tier width (9 visible
 * chars: " ○$:" + " " + "  off") so it slots into the existing column
 * grid instead of drifting under the full-tier reset slot.
 */
function renderExtraUsage(usage: UsageData, now: number, detail: DetailLevel): string | null {
  if (!usage.extraUsage) return null;
  if (!usage.extraUsage.enabled) {
    // Pad the placeholder to the active tier's width so the segment
    // aligns with neighbouring quota segments (which all render at
    // exactly TIER_SEGMENT_WIDTH[detail] visible chars).
    const placeholder = `${dim(' ○$:')} ${dim(' off')}`;
    const target = TIER_SEGMENT_WIDTH[detail];
    return placeholder + ' '.repeat(Math.max(0, target - visibleLength(placeholder)));
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

export function render(input: RenderInput): void {
  const { stdin, usage, git } = input;
  const now = input.now ?? Date.now();
  const cols = input.columns ?? 120;
  const rows = Math.min(input.rows ?? 3, 3);

  // ── Column-0 width: pad model and plan to the same width so bars align ─────
  // Only relevant when rows ≥ 2 (multi-line output).
  const modelText = modelDisplay(getModelName(stdin), getEffortLevel(stdin));
  const planText  = (usage?.planName ?? '').toLowerCase();
  // The dashboard link is pinned to the model prefix on line 1 — " ⧉" =
  // 2 visible chars. Lines 2 and 3 don't carry the link, so col0Width
  // includes the link width on the model side and a clamp for the
  // fetch-time stamp ("⟳HH:MM" = 6) so neither overflows pad0.
  const LINK_WIDTH = 2;
  const FETCH_TIME_WIDTH = 6;
  const col0Width = Math.max(modelText.length + LINK_WIDTH, planText.length, FETCH_TIME_WIDTH);

  // Pad visible text to col0Width; ANSI color wraps the unpadded text, spaces follow.
  const pad0 = (text: string, color: string) =>
    `${color}${text}${R}${' '.repeat(Math.max(0, col0Width - text.length))}`;

  // ── Line 1 ────────────────────────────────────────────────────────────────
  const ctxPct = getContextPercent(stdin);
  const ctxPctStr = `${ctxPct}%`.padStart(4);
  const project = getProjectName(stdin);

  let line1: string;

  // The dashboard link is pinned to the model prefix on every layout
  // height. " ⧉" (2 visible chars). Always shown so the affordance is
  // discoverable on narrow terminals too.
  const link = ` ${dashLinkGlyph()}`;

  // API status hint shown at the right edge of the line.
  // ' ⟳' (2 visible chars) for rate-limited; ' ⚠' for any other failure.
  // Reserved here so rows=1 + rows≥2 can both append it at the proper width.
  const apiHint = usage?.apiError === 'rate-limited'
    ? dim(' ⟳')
    : usage?.apiUnavailable
      ? c(YELLOW, ' ⚠')
      : '';
  const apiHintW = visibleLength(apiHint);

  if (rows === 1) {
    // Single-row mode: model + link + compact ctx + compact 5h + compact 7d
    // when usage is available. Bars omitted; compact (label + pct) format
    // throughout. Git info is dropped in favour of quota percentages.
    // The rate-limit / API-down hint is appended on the right so the
    // user sees the same status indicator they'd see at rows=3.
    const ctxCompact = `${dim('ctx:')} ${ctxColor(ctxPct)}${ctxPctStr}${R}`;
    const showQuotas = !!usage && !usage.apiUnavailable;
    const parts: (string | null)[] = [
      `${c(CYAN, modelText)}${link}`,
      ctxCompact,
      showQuotas ? renderQuota(' 5h:', usage.fiveHour, usage.fiveHourResetAt, FIVE_HOUR_MS, now, 'compact') : null,
      showQuotas ? renderQuota(' 7d:', usage.sevenDay, usage.sevenDayResetAt, SEVEN_DAY_MS, now, 'compact') : null,
    ];
    line1 = truncate(
      parts.filter((p): p is string => p !== null).join(SEP),
      cols - apiHintW,
    ) + apiHint;
  } else {
    // Multi-row mode: model + link + ctx bar + project/git.
    // Git degrades via detail tiers; the link is part of the col-0 prefix
    // and never drops out.
    const ctxBar = bar(ctxPct, 10, ctxColor);
    const ctxSegment = `${dim('ctx:')}${ctxBar} ${ctxColor(ctxPct)}${ctxPctStr}${R}`;
    // pad0 still pads to col0Width; we manually inject the link inside
    // the colored model text so visible width = modelText + LINK_WIDTH.
    const modelPrefix = `${CYAN}${modelText}${R}${link}`
      + ' '.repeat(Math.max(0, col0Width - modelText.length - LINK_WIDTH));
    line1 = fitLine(
      (detail) => [
        modelPrefix,
        ctxSegment,
        renderGit(project, git, detail),
      ],
      cols,
    );
  }
  console.log(`${R}${line1}`);

  if (rows < 2) return;

  // ── Lines 2 & 3: account ──────────────────────────────────────────────────
  // rows=2 layout:  plan │ 5h │ 7d │ snt │ ops │ $  (all quotas on one line)
  // rows≥3 layout:
  //   Line 2: plan │  5h bar pct% pace reset │ snt bar pct% pace reset
  //   Line 3: time │  7d bar pct% pace reset │  ●$ bar val  pace limit

  if (usage && !usage.apiUnavailable) {
    const syncHint = usage.apiError === 'rate-limited' ? dim(' ⟳') : '';
    // visibleLength(syncHint) = 2 when rate-limited, 0 otherwise.
    // fitLine is called with cols reduced by this amount so that appending
    // syncHint never pushes the output line past the terminal width.
    const syncW = visibleLength(syncHint);

    if (rows === 2) {
      // Flatten all quotas onto a single line.
      const hasContent =
        usage.fiveHour !== null || usage.sevenDay !== null ||
        usage.sonnet !== null || usage.opus !== null ||
        usage.extraUsage !== null || !!planText;
      if (hasContent) {
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
        console.log(`${R}${line2}${syncHint}`);
      } else if (usage.apiError === 'rate-limited') {
        console.log(`${R}${dim('⟳')}`);
      }
    } else {
      // rows ≥ 3: standard two-account-line layout.
      // hasLine3 is needed before line 2 is built so we know where syncHint lands.
      const hasLine3 = usage.sevenDay !== null || usage.opus !== null || usage.extraUsage !== null;
      const line2HasContent = usage.fiveHour !== null || usage.sonnet !== null || !!planText;
      if (line2HasContent) {
        // syncHint goes on line 2 only when there is no line 3.
        const line2 = fitLine(
          (detail) => [
            planText ? pad0(planText, CYAN) : null,
            renderQuota(' 5h:', usage.fiveHour, usage.fiveHourResetAt, FIVE_HOUR_MS, now, detail),
            renderQuota('snt:', usage.sonnet, usage.sonnetResetAt, SEVEN_DAY_MS, now, detail),
          ],
          cols - (hasLine3 ? 0 : syncW),
        );
        console.log(`${R}${line2}${hasLine3 ? '' : syncHint}`);
      }

      if (hasLine3) {
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
        console.log(`${R}${line3}${syncHint}`);
      } else if (!planText && !line2HasContent && usage.apiError === 'rate-limited') {
        console.log(`${R}${dim('⟳')}`);
      }
    }
  } else if (usage?.apiUnavailable) {
    // Match the single-line and syncHint presentations: bare glyph,
    // dim ⟳ for rate-limited, yellow ⚠ for everything else. The
    // "usage:" prefix used to make this branch read differently from
    // the other three places the same status surfaces — now they all
    // look the same.
    const hint = usage.apiError === 'rate-limited' ? dim('⟳') : c(YELLOW, '⚠');
    if (planText) {
      console.log(`${R}${c(CYAN, planText)}${dim(' │ ')}${hint}`);
    } else {
      console.log(`${R}${hint}`);
    }
  } else if (planText) {
    console.log(`${R}${c(CYAN, planText)}`);
  }
}
