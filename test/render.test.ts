import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { render, modelDisplay, calcPace } from '../src/render.js';
import type { RenderInput } from '../src/render.js';
import type { UsageData } from '../src/types.js';

/** Visible character count (strip ANSI, then measure length). */
const vlen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/** Strip ANSI escape codes for plain-text assertions. */
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function capture(input: Omit<RenderInput, 'now'> & { now?: number }): { line1: string; line2: string; line3: string; full: string } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  render(input);
  console.log = orig;
  const stripped = lines.map(strip);
  return { line1: stripped[0] ?? '', line2: stripped[1] ?? '', line3: stripped[2] ?? '', full: stripped.join('\n') };
}

const now = Date.now();
const in3h = new Date(now + 3 * 60 * 60 * 1000);       // 3h remaining of 5h → 2h elapsed (40%)
const in3d = new Date(now + 3 * 24 * 60 * 60 * 1000);   // 3d remaining of 7d → 4d elapsed (~57%)

const baseStdin = {
  model: { display_name: 'Claude Sonnet 4.6' },
  effort_level: 'high',
  context_window: {
    current_usage: { input_tokens: 40_000 },
    context_window_size: 200_000,
  },
  cwd: '/home/user/my-project',
};

const baseUsage: UsageData = {
  planName: 'Max',
  fiveHour: 36,
  fiveHourResetAt: in3h,
  sevenDay: 18,
  sevenDayResetAt: in3d,
  sonnet: 56,
  sonnetResetAt: in3d,
  opus: null,
  opusResetAt: null,
  extraUsage: null,
};

// ── modelDisplay ──────────────────────────────────────────────────────────

describe('modelDisplay', () => {
  test('shows family + effort when both are present', () => {
    assert.equal(modelDisplay('Claude Sonnet 4.6', 'high'),   'sonnet high');
    assert.equal(modelDisplay('Claude Opus 4.6',   'medium'), 'opus medium');
    assert.equal(modelDisplay('Claude Haiku 4.5',  'low'),    'haiku low');
  });

  test('lowercases effort', () => {
    assert.equal(modelDisplay('Claude Sonnet 4.6', 'High'), 'sonnet high');
  });

  test('shows only family when effort is absent', () => {
    assert.equal(modelDisplay('Claude Sonnet 4.6', null),      'sonnet');
    assert.equal(modelDisplay('Claude Sonnet 4.6', undefined), 'sonnet');
  });

  test('handles input without "Claude " prefix', () => {
    assert.equal(modelDisplay('Sonnet 4.6', 'high'), 'sonnet high');
  });

  test('handles legacy "Major.Minor Family" format', () => {
    assert.equal(modelDisplay('Claude 3.5 Sonnet', 'high'), 'sonnet high');
  });
});

// ── calcPace ─────────────────────────────────────────────���──────────────────

describe('calcPace', () => {
  const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

  test('returns null when resetAt is null', () => {
    assert.equal(calcPace(50, null, SEVEN_DAY_MS, now), null);
  });

  test('returns null when window just started (< 2% elapsed)', () => {
    const almostFull = new Date(now + SEVEN_DAY_MS - 1000); // 1s elapsed
    assert.equal(calcPace(1, almostFull, SEVEN_DAY_MS, now), null);
  });

  test('returns null when reset is in the past', () => {
    const past = new Date(now - 1000);
    assert.equal(calcPace(50, past, SEVEN_DAY_MS, now), null);
  });

  test('under-pace gives ↘ glyph', () => {
    // 4d elapsed of 7d (57%), used only 18% → paceRatio = 0.18/0.57 = 0.32 < 0.85
    const result = calcPace(18, in3d, SEVEN_DAY_MS, now);
    assert.ok(result, 'expected a result');
    assert.equal(result.glyph, '↘');
  });

  test('on-pace gives → glyph', () => {
    // 4d elapsed (~57%), used ~57% → paceRatio ≈ 1.0
    const pct = Math.round(0.57 * 100); // 57%
    const result = calcPace(pct, in3d, SEVEN_DAY_MS, now);
    assert.ok(result, 'expected a result');
    assert.equal(result.glyph, '→');
  });

  test('over-pace gives ↗ glyph', () => {
    // 4d elapsed (~57%), used 80% → paceRatio = 0.80/0.57 = 1.40 > 1.15
    const result = calcPace(80, in3d, SEVEN_DAY_MS, now);
    assert.ok(result, 'expected a result');
    assert.equal(result.glyph, '↗');
  });

  test('calculates projected end-of-window utilization', () => {
    // 4d elapsed of 7d (4/7 ≈ 57.14%), used 18% → projected = round(18/0.5714) = 32%
    const result = calcPace(18, in3d, SEVEN_DAY_MS, now);
    assert.equal(result?.projected, 32);
  });
});

// ── two-line layout ──────────────────────────��─────────────────────────────

describe('two-line layout', () => {
  test('line 1 shows "family effort" model format', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line1.includes('sonnet high'), 'model display missing');
    assert.ok(!line1.includes('['), 'no brackets expected');
    assert.ok(!line1.includes('Claude'), '"Claude" prefix should be stripped');
  });

  test('line 1 has context bar and percentage', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line1.includes('20%'), 'context percentage missing');
    assert.ok(line1.includes('█'), 'context bar missing');
  });

  test('line 1 has project name', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line1.includes('my-project'), 'project name missing');
  });

  test('line 1 has git branch', () => {
    const { line1 } = capture({
      stdin: baseStdin, usage: baseUsage,
      git: { branch: 'main', isDirty: false }, now,
    });
    assert.ok(line1.includes('main'), 'branch missing');
    assert.ok(!line1.includes('main*'), 'should not be dirty');
  });

  test('dirty git repo shows asterisk on line 1', () => {
    const { line1 } = capture({
      stdin: baseStdin, usage: baseUsage,
      git: { branch: 'feature', isDirty: true }, now,
    });
    assert.ok(line1.includes('feature*'), 'dirty marker missing');
  });

  test('line 2 has plan name in lowercase', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line2.includes('max'), 'lowercase plan missing from line 2');
    assert.ok(!line2.includes('Max'), 'plan should be lowercase');
  });

  test('plan name is not on line 1', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(!line1.includes('max') && !line1.includes('Max'), 'plan should not be on line 1');
  });

  test('no line 2 when usage is null', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: null, git: null, now });
    assert.equal(line2, '');
  });
});

// ── quota bars and pace ────────────────────────────────────────────────────

describe('quota rendering', () => {
  test('line 2 has mini bar for each quota', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line2.includes('░') || line2.includes('█'), 'bar chars missing from quota line');
  });

  test('quota metrics are separated by │', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line2.includes('│'), 'separator missing between metrics');
  });

  test('reset timer uses ↺ symbol', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line2.includes('↺'), '↺ reset symbol missing');
    assert.ok(!line2.includes('↻'), 'old ↻ symbol should not appear');
  });

  test('line 2 has 5h and 7d labels and values', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line2.includes('5h:'), '5h label missing from line2');
    assert.ok(line2.includes('36%'), '5h value missing from line2');
    assert.ok(line2.includes('7d:'), '7d label missing from line2');
    assert.ok(line2.includes('18%'), '7d value missing from line2');
  });

  test('line 3 has sonnet label and value', () => {
    const { line3 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line3.includes('snt:'), 'sonnet label missing from line3');
    assert.ok(line3.includes('56%'), 'sonnet value missing from line3');
  });

  test('pace glyph and projected value appear after usage %', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    // 5h: 36% used, 2h elapsed of 5h (40%) → projected = round(36/0.4) = 90%
    //     paceRatio = 36/(0.40×100) = 0.90 → on-pace band → →
    // projected "90%" is padded to " 90%" so it appears as "→ 90%"
    assert.ok(line2.includes('→ 90%'), '5h pace+projected missing');
    // 7d: 18% used, 4d elapsed of 7d (~57%) → projected = 32%
    //     paceRatio = 18/(0.57×100) = 0.32 → under pace → ↘
    // projected "32%" is padded to " 32%" so it appears as "↘ 32%"
    assert.ok(line2.includes('↘ 32%'), '7d pace+projected missing');
  });

  test('over-pace shows ↗ and projected > 100%', () => {
    const overPace: UsageData = { ...baseUsage, sevenDay: 80, sevenDayResetAt: in3d };
    const { line2 } = capture({ stdin: baseStdin, usage: overPace, git: null, now });
    // 80% used, 4d/7d elapsed → projected = round(80/0.571) = 140%
    // "140%" is already 4 chars, no extra padding needed → "↗140%"
    assert.ok(line2.includes('↗140%'), 'over-pace indicator missing');
  });

  test('no pace glyph when window just started', () => {
    const justReset: UsageData = {
      ...baseUsage,
      fiveHour: 1,
      fiveHourResetAt: new Date(now + 5 * 60 * 60 * 1000 - 3000), // 3s elapsed
    };
    const { line2 } = capture({ stdin: baseStdin, usage: justReset, git: null, now });
    const fhSection = line2.split('7d:')[0];
    assert.ok(!fhSection.includes('↘') && !fhSection.includes('↗'), 'no pace expected this early');
  });

  test('no pace glyph when resetAt is null', () => {
    const noReset: UsageData = {
      ...baseUsage,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      sonnetResetAt: null,
    };
    const { full } = capture({ stdin: baseStdin, usage: noReset, git: null, now });
    // Strip line 1 which has the context bar (no pace glyphs expected there)
    const accountLines = full.split('\n').slice(1).join('\n');
    assert.ok(!accountLines.includes('↘') && !accountLines.includes('↗') && !accountLines.includes('→'), 'no pace without resetAt');
  });
});

// ── extra usage ────────────────────────────────────────────────────────────

describe('extra usage rendering', () => {
  test('shows ●$: label, bar, current, projected, limit', () => {
    const withExtra: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 50 },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: withExtra, git: null, now });
    assert.ok(line3.includes('●$:'), '●$: label missing');
    assert.ok(line3.includes('$50'), 'current spend missing');
    assert.ok(line3.includes('$500'), 'limit missing');
  });

  test('shows pace glyph and projected spend', () => {
    const withExtra: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 50 },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: withExtra, git: null, now });
    const afterDollar = line3.split('$:')[1] ?? '';
    const hasGlyph = afterDollar.includes('↘') || afterDollar.includes('→') || afterDollar.includes('↗');
    assert.ok(hasGlyph, 'pace glyph missing from extra usage');
  });

  test('$0 spent still shows pace (projected $0)', () => {
    const zeroed: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 0 },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: zeroed, git: null, now });
    assert.ok(line3.includes('●$:'), '●$: label missing');
    assert.ok(line3.includes('$0'), '$0 spend missing');
  });
});

// ── error states ───────────────────────────────────────────────────────────

describe('error states', () => {
  test('rate-limited indicator shown when quotas have values', () => {
    const rateLimited: UsageData = { ...baseUsage, apiError: 'rate-limited' };
    const { full } = capture({ stdin: baseStdin, usage: rateLimited, git: null, now });
    assert.ok(full.includes('⟳'), 'rate-limited indicator missing');
  });

  test('rate-limited indicator shown when all quotas are null', () => {
    const rateLimited: UsageData = {
      ...baseUsage,
      fiveHour: null, sevenDay: null, sonnet: null, opus: null,
      apiError: 'rate-limited',
    };
    const { full } = capture({ stdin: baseStdin, usage: rateLimited, git: null, now });
    assert.ok(full.includes('⟳'), 'rate-limited indicator missing with null quotas');
  });

  test('API unavailable shows warning', () => {
    const unavailable: UsageData = {
      ...baseUsage,
      fiveHour: null, sevenDay: null, sonnet: null, opus: null,
      apiUnavailable: true, apiError: 'network',
    };
    const { line2 } = capture({ stdin: baseStdin, usage: unavailable, git: null, now });
    assert.ok(line2.includes('usage:⚠'), 'unavailable indicator missing');
    assert.ok(line2.includes('max'), 'plan name missing from unavailable line');
  });
});

// ── width-adaptive rendering ───────────────────────────────────────────────
//
// Thresholds are derived from the baseStdin + baseUsage fixture:
//   col0Width = max("sonnet high"=11, "max"=3) = 11
//   ctx segment visible width = 19
//   SEP " │ " = 3
//
//   Line 1 (model │ ctx │ git):
//     full / no-reset: 11+3+19+3+21 = 57  (git = "my-project git:(main)" = 21)
//     no-pace:         11+3+19+3+10 = 46  (git = "my-project" = 10)
//     compact:         11+3+19      = 33  (git omitted)
//
//   Line 2 (plan │ 5h │ 7d), each quota at each tier:
//     full:      11+3+32+3+32 = 81
//     no-reset:  11+3+25+3+25 = 67
//     no-pace:   11+3+19+3+19 = 55
//     compact:   11+3+ 9+3+ 9 = 35

const baseGit = { branch: 'main', isDirty: false };

describe('width-adaptive rendering', () => {
  // ── line 2 tier boundaries ──────────────────────────────────────────────

  test('line 2 shows reset timer at exactly the full-tier width', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 81 });
    assert.ok(line2.includes('↺'), 'reset timer should be present at full width');
  });

  test('line 2 drops reset timer one column below full-tier width', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 80 });
    assert.ok(!line2.includes('↺'), 'reset timer should be dropped below full-tier width');
    const hasGlyph = line2.includes('↘') || line2.includes('→') || line2.includes('↗');
    assert.ok(hasGlyph, 'pace glyph should still be present in no-reset tier');
  });

  test('line 2 shows pace glyph at exactly the no-reset-tier width', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 67 });
    const hasGlyph = line2.includes('↘') || line2.includes('→') || line2.includes('↗');
    assert.ok(hasGlyph, 'pace glyph should be present at no-reset-tier width');
  });

  test('line 2 drops pace glyph one column below no-reset-tier width', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 66 });
    assert.ok(!line2.includes('↺'), 'reset timer should be absent');
    const hasGlyph = line2.includes('↘') || line2.includes('→') || line2.includes('↗');
    assert.ok(!hasGlyph, 'pace glyph should be dropped below no-reset-tier width');
    assert.ok(line2.includes('█') || line2.includes('░'), 'bar chars should still be present');
  });

  test('line 2 drops bars in compact tier', () => {
    // compact tier renders 35 visible chars exactly; use columns=35 to avoid hard truncation
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 35 });
    assert.ok(!line2.includes('█') && !line2.includes('░'), 'bar chars should be absent in compact tier');
    assert.ok(line2.includes('36%'), '5h percentage must still be visible');
    assert.ok(line2.includes('18%'), '7d percentage must still be visible');
  });

  // ── line 1 git degradation ──────────────────────────────────────────────

  test('line 1 shows branch at exactly the full-tier width', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns: 57 });
    assert.ok(line1.includes('main'), 'branch should be present at full-tier width');
  });

  test('line 1 drops branch one column below full-tier width', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns: 56 });
    assert.ok(!line1.includes('main'), 'branch should be dropped below full-tier width');
    assert.ok(line1.includes('my-project'), 'project name should still be present');
  });

  test('line 1 drops project name below no-pace-tier width', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns: 45 });
    assert.ok(!line1.includes('my-project'), 'project should be dropped below no-pace-tier width');
    assert.ok(line1.includes('sonnet'), 'model name must remain');
  });

  // ── line length invariant ───────────────────────────────────────────────

  test('no line exceeds the specified column width', () => {
    const widths = [20, 33, 35, 45, 46, 55, 57, 67, 80, 81, 120, 200];
    for (const columns of widths) {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(' '));
      render({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns });
      console.log = orig;
      for (const line of lines) {
        const visible = vlen(line);
        assert.ok(
          visible <= columns,
          `line visible length ${visible} exceeds columns=${columns}: "${line.replace(/\x1b\[[0-9;]*m/g, '')}"`,
        );
      }
    }
  });
});
