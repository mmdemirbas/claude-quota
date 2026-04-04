import type { StdinData, UsageData, GitStatus } from './types.js';
import { getModelName, getContextPercent, getProjectName, getEffortLevel } from './stdin.js';

// ── ANSI colors ────────────────────────────────────────────────────────────

const R = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const B_BLUE = '\x1b[94m';
const B_MAG = '\x1b[95m';

const c = (color: string, text: string) => `${color}${text}${R}`;
const dim = (text: string) => c(DIM, text);

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

function bar(pct: number, width: number, colorFn: (p: number) => string): string {
  const safe = Math.max(0, Math.min(100, pct));
  const filled = Math.round((safe / 100) * width);
  const empty = width - filled;
  return `${colorFn(safe)}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${R}`;
}

// ── Time formatting ────────────────────────────────────────────────────────

/** Exported for testing. */
export function resetIn(resetAt: Date | null, now: number): string {
  if (!resetAt) return '';
  const diffMs = resetAt.getTime() - now;
  if (diffMs <= 0) return '';

  const mins = Math.ceil(diffMs / 60000);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH > 0 ? `${days}d${remH}h` : `${days}d`;
  }

  return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
}

// ── Pace calculation ────────────────────────────────────────────────────────

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

export interface PaceResult {
  projected: number;
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
  const remaining = resetAt.getTime() - now;
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

  return { projected, glyph, glyphColor };
}

/** Day-of-month elapsed fraction for monthly spend pace. */
function monthElapsedFraction(now: number): number {
  const d = new Date(now);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const elapsed = (d.getDate() - 1) + d.getHours() / 24 + d.getMinutes() / (24 * 60);
  return elapsed / daysInMonth;
}

// ── Segment rendering ──────────────────────────────────────────────────────

// Fixed visible widths for alignment across lines:
//   label: 4   bar: 10   space: 1   pct: 4   pace: 6   reset: 7
//   Total per quota metric: 32 visible chars

/** Format with fixed-width fields so bars, pcts, glyphs, and resets align. */
function renderQuota(
  label: string,  // must be exactly 4 visible chars (e.g. " 5h:", "snt:")
  pct: number | null,
  resetAt: Date | null,
  windowMs: number,
  now: number,
): string | null {
  if (pct === null) return null;

  const b = bar(pct, 10, quotaColor);
  const pace = calcPace(pct, resetAt, windowMs, now);
  const reset = resetIn(resetAt, now);

  // pct: right-justify in 4 chars → " 17%", "100%"
  const pctStr = `${pct}%`.padStart(4);

  // pace: 1(space) + 1(glyph) + 4(proj padded) = 6 chars, or 6 spaces
  let paceStr: string;
  if (pace) {
    const projStr = `${pace.projected}%`.padStart(4);
    paceStr = ` ${pace.glyphColor}${pace.glyph}${R}${projectedColor(pace.projected)}${projStr}${R}`;
  } else {
    paceStr = '      '; // 6 spaces
  }

  // reset: 1(space) + up to 6(↺+time padded to 6) = 7 chars, or 7 spaces
  let resetStr: string;
  if (reset) {
    const resetPad = `↺${reset}`.padEnd(6);
    resetStr = ` ${dim(resetPad)}`;
  } else {
    resetStr = '       '; // 7 spaces
  }

  return `${dim(label)}${b} ${quotaColor(pct)}${pctStr}${R}${paceStr}${resetStr}`;
}

/** Exported for testing. */
export function formatMoney(amount: number): string {
  if (amount === 0) return '$0';
  if (amount < 1)   return `$${amount.toFixed(2)}`;
  return `$${Math.round(amount)}`;
}

/** Format:  $:● bar $value{glyph}{$projected}/$limit  or  $:○ when disabled */
function renderExtraUsage(usage: UsageData, now: number): string | null {
  if (!usage.extraUsage) return null;
  if (!usage.extraUsage.enabled) return `${dim(' ○$:')}`;

  const { usedCredits, monthlyLimit } = usage.extraUsage;
  const usedPct = Math.min(100, Math.round((usedCredits / monthlyLimit) * 100));
  const ratio = usedCredits / monthlyLimit;

  const b = bar(usedPct, 10, moneyBarColor);

  const elapsedFraction = monthElapsedFraction(now);
  let paceStr = '';
  if (elapsedFraction >= 0.02) {
    const projectedSpend = usedCredits / elapsedFraction;
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
    paceStr = ` ${glyphColor}${glyph}${R}${projColor}${formatMoney(projectedSpend)}${R}`;
  }

  return `${dim(' ●$:')}${b} ${moneyValueColor(ratio)}${formatMoney(usedCredits)}${R}${paceStr}${dim('/')}${dim(formatMoney(monthlyLimit))}`;
}

// ── Main render ────────────────────────────────────────────────────────────

export interface RenderInput {
  stdin: StdinData;
  usage: UsageData | null;
  git: GitStatus | null;
  /** Override current timestamp (ms). Used in tests for determinism. */
  now?: number;
}

export function render(input: RenderInput): void {
  const { stdin, usage, git } = input;
  const now = input.now ?? Date.now();

  // ── Column-0 width: pad model and plan to the same width so bars align ─────
  const modelText = modelDisplay(getModelName(stdin), getEffortLevel(stdin));
  const planText  = (usage?.planName ?? '').toLowerCase();
  const col0Width = Math.max(modelText.length, planText.length);

  // Pad visible text to col0Width; ANSI color goes around the unpadded text, spaces follow
  const pad0 = (text: string, color: string) =>
    `${color}${text}${R}${' '.repeat(col0Width - text.length)}`;

  // ── Line 1: model │ ctx: bar pct% │ project git ────────────────────────────
  const ctxPct = getContextPercent(stdin);
  const ctxBar = bar(ctxPct, 10, ctxColor);
  const ctxPctStr = `${ctxPct}%`.padStart(4);

  const line1: string[] = [];
  line1.push(pad0(modelText, CYAN));
  line1.push(`${dim('ctx:')}${ctxBar} ${ctxColor(ctxPct)}${ctxPctStr}${R}`);

  const project = getProjectName(stdin);
  if (project) {
    let projectPart = c(YELLOW, project);
    if (git) {
      const branchStr = git.branch + (git.isDirty ? '*' : '');
      projectPart += ` ${c(MAGENTA, 'git:(')}${c(CYAN, branchStr)}${c(MAGENTA, ')')}`;
    }
    line1.push(projectPart);
  }

  console.log(`${R}${line1.join(dim(' │ '))}`);

  // ── Lines 2 & 3: account ──────────────────────────────────────────────────
  // Layout (labels all 4 visible chars so bars align across lines):
  //   Line 2: plan_padded │  5h: bar pct% pace reset │  7d: bar pct% pace reset
  //   Line 3: spaces      │ snt: bar pct% pace reset │  ●$: bar val  pace limit

  if (usage && !usage.apiUnavailable) {
    const line2: string[] = [];
    const line3: string[] = [];

    if (planText) line2.push(pad0(planText, CYAN));

    const fh = renderQuota(' 5h:', usage.fiveHour, usage.fiveHourResetAt, FIVE_HOUR_MS, now);
    if (fh) line2.push(fh);
    const sd = renderQuota(' 7d:', usage.sevenDay, usage.sevenDayResetAt, SEVEN_DAY_MS, now);
    if (sd) line2.push(sd);

    const snt = renderQuota('snt:', usage.sonnet, usage.sonnetResetAt, SEVEN_DAY_MS, now);
    if (snt) line3.push(snt);
    const opus = renderQuota('ops:', usage.opus, usage.opusResetAt, SEVEN_DAY_MS, now);
    if (opus) line3.push(opus);
    const extra = renderExtraUsage(usage, now);
    if (extra) line3.push(extra);

    const syncHint = usage.apiError === 'rate-limited' ? dim(' ⟳') : '';

    if (line2.length > 0 || planText) {
      console.log(`${R}${line2.join(dim(' │ '))}${line3.length ? '' : syncHint}`);
    }
    if (line3.length > 0) {
      const spacer = ' '.repeat(col0Width);
      const parts = planText ? [spacer, ...line3] : line3;
      console.log(`${R}${parts.join(dim(' │ '))}${syncHint}`);
    } else if (!planText && line2.length === 0 && usage.apiError === 'rate-limited') {
      console.log(`${R}${dim('⟳')}`);
    }
  } else if (usage?.apiUnavailable) {
    const hint = usage.apiError === 'rate-limited' ? '⟳' : '⚠';
    if (planText) {
      console.log(`${R}${c(CYAN, planText)}${dim(' │ ')}${c(YELLOW, `usage:${hint}`)}`);
    } else {
      console.log(`${R}${c(YELLOW, `usage:${hint}`)}`);
    }
  } else if (planText) {
    console.log(`${R}${c(CYAN, planText)}`);
  }
}
