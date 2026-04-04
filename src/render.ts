import type { StdinData, UsageData, GitStatus } from './types.js';
import { getModelName, getContextPercent, getProjectName } from './stdin.js';

// ── ANSI colors ────────────────────────────────────────────────────────────

const R = '\x1b[0m';       // reset
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

function moneyColor(used: number, limit: number): string {
  if (limit <= 0) return DIM;
  const ratio = used / limit;
  if (ratio >= 0.8) return RED;
  if (ratio > 0) return YELLOW;
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

function resetIn(resetAt: Date | null): string {
  if (!resetAt) return '';
  const diffMs = resetAt.getTime() - Date.now();
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

// ── Usage segment rendering ────────────────────────────────────────────────

function renderQuota(label: string, pct: number | null, resetAt: Date | null): string | null {
  if (pct === null) return null;
  const reset = resetIn(resetAt);
  const colored = `${quotaColor(pct)}${pct}%${R}`;
  if (reset) {
    return `${dim(label)}${colored}${dim('↻' + reset)}`;
  }
  return `${dim(label)}${colored}`;
}

function renderExtraUsage(usage: UsageData): string | null {
  if (!usage.extraUsage || !usage.extraUsage.enabled) return null;

  const { usedCredits, monthlyLimit } = usage.extraUsage;
  const usedStr = usedCredits < 1 ? `$${usedCredits.toFixed(2)}` : `$${Math.round(usedCredits)}`;
  const limitStr = monthlyLimit < 1 ? `$${monthlyLimit.toFixed(2)}` : `$${Math.round(monthlyLimit)}`;
  const color = moneyColor(usedCredits, monthlyLimit);
  return `${color}${usedStr}${R}${dim('/')}${dim(limitStr)}`;
}

// ── Main render ────────────────────────────────────────────────────────────

export interface RenderInput {
  stdin: StdinData;
  usage: UsageData | null;
  git: GitStatus | null;
}

export function render(input: RenderInput): void {
  const { stdin, usage, git } = input;
  const parts: string[] = [];

  // ─ Model + Plan ─
  const model = getModelName(stdin);
  const plan = usage?.planName;
  const modelStr = plan ? `${model} | ${plan}` : model;

  // ─ Context bar ─
  const ctxPct = getContextPercent(stdin);
  const ctxBar = bar(ctxPct, 8, ctxColor);
  const ctxVal = `${ctxColor(ctxPct)}${ctxPct}%${R}`;
  parts.push(`${c(CYAN, `[${modelStr}]`)} ${ctxBar} ${ctxVal}`);

  // ─ Project + Git ─
  const project = getProjectName(stdin);
  if (project) {
    let projectPart = c(YELLOW, project);
    if (git) {
      const branchStr = git.branch + (git.isDirty ? '*' : '');
      projectPart += ` ${c(MAGENTA, 'git:(')}${c(CYAN, branchStr)}${c(MAGENTA, ')')}`;
    }
    parts.push(projectPart);
  }

  // ─ Usage quotas ─
  if (usage && !usage.apiUnavailable) {
    const quotaParts: string[] = [];

    const fh = renderQuota('5h:', usage.fiveHour, usage.fiveHourResetAt);
    if (fh) quotaParts.push(fh);

    const sd = renderQuota('7d:', usage.sevenDay, usage.sevenDayResetAt);
    if (sd) quotaParts.push(sd);

    const snt = renderQuota('snt:', usage.sonnet, usage.sonnetResetAt);
    if (snt) quotaParts.push(snt);

    const opus = renderQuota('ops:', usage.opus, usage.opusResetAt);
    if (opus) quotaParts.push(opus);

    const extra = renderExtraUsage(usage);
    if (extra) quotaParts.push(extra);

    const syncHint = usage.apiError === 'rate-limited' ? dim('⟳') : '';
    if (quotaParts.length > 0) {
      parts.push(quotaParts.join(' ') + (syncHint ? ` ${syncHint}` : ''));
    } else if (syncHint) {
      parts.push(syncHint);
    }
  } else if (usage?.apiUnavailable) {
    const hint = usage.apiError === 'rate-limited' ? '⟳' : '⚠';
    parts.push(c(YELLOW, `usage:${hint}`));
  }

  const line = `${R}${parts.join(dim(' │ '))}`;
  console.log(line);
}
