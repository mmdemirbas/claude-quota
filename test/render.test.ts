import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { render, modelDisplay, calcPace, formatBalance } from '../src/render.js';
import type { RenderInput } from '../src/render.js';
import type { UsageData } from '../src/types.js';
import { visibleLength } from '../src/ansi.js';

/** Visible character count (strip ANSI SGR + OSC 8 frames, then measure length). */
const vlen = (s: string) => visibleLength(s);

/**
 * Strip all supported ANSI escape sequences (SGR colours + OSC 8
 * hyperlinks) for plain-text assertions. OSC 8 frames are removed
 * wholesale, leaving only the clickable text visible to substring
 * checks like line.includes('main').
 */
const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;]*m/g, '')
   .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

function capture(input: Omit<RenderInput, 'now'> & { now?: number }): { line1: string; line2: string; line3: string; full: string } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  // try/finally so a render() throw cannot leave console.log patched and
  // contaminate every subsequent test in the suite.
  try {
    render(input);
  } finally {
    console.log = orig;
  }
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

  test('reset timer uses a filled-circle glyph (○◔◑◕●)', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    const hasCircle = /[○◔◑◕●]/.test(line2);
    assert.ok(hasCircle, 'filled-circle reset glyph missing from line2');
    assert.ok(!line2.includes('↺'), '↺ should no longer appear');
    assert.ok(!line2.includes('↻'), 'old ↻ symbol should not appear');
  });

  test('line 2 has 5h and snt labels and values', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line2.includes('5h:'), '5h label missing from line2');
    assert.ok(line2.includes('36%'), '5h value missing from line2');
    assert.ok(line2.includes('snt:'), 'snt label missing from line2');
    assert.ok(line2.includes('56%'), 'snt value missing from line2');
  });

  test('line 3 has 7d label and value', () => {
    const { line3 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    assert.ok(line3.includes('7d:'), '7d label missing from line3');
    assert.ok(line3.includes('18%'), '7d value missing from line3');
  });

  test('pace glyph and projected value appear after usage %', () => {
    const { line2, line3 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now });
    // 5h: 36% used, 2h elapsed of 5h (40%) → projected = round(36/0.4) = 90%
    //     paceRatio = 36/(0.40×100) = 0.90 → on-pace band → →
    // projected "90%" is padded to " 90%" so it appears as "→ 90%"
    assert.ok(line2.includes('→ 90%'), '5h pace+projected missing');
    // snt: 56% used, 4d elapsed of 7d (~57%) → projected = round(56/0.5714) = 98%
    //      paceRatio = 56/(0.57×100) = 0.98 → on-pace → →
    assert.ok(line2.includes('→ 98%'), 'snt pace+projected missing');
    // 7d: 18% used, 4d elapsed of 7d (~57%) → projected = 32%
    //     paceRatio = 18/(0.57×100) = 0.32 → under pace → ↘
    // projected "32%" is padded to " 32%" so it appears as "↘ 32%"
    assert.ok(line3.includes('↘ 32%'), '7d pace+projected missing');
  });

  test('over-pace shows ↗ and projected > 100%', () => {
    const overPace: UsageData = { ...baseUsage, sevenDay: 80, sevenDayResetAt: in3d };
    const { line3 } = capture({ stdin: baseStdin, usage: overPace, git: null, now });
    // 80% used, 4d/7d elapsed → projected = round(80/0.571) = 140%
    // "140%" is already 4 chars, no extra padding needed → "↗140%"
    assert.ok(line3.includes('↗140%'), 'over-pace indicator missing');
  });

  test('no pace glyph when window just started', () => {
    const justReset: UsageData = {
      ...baseUsage,
      fiveHour: 1,
      fiveHourResetAt: new Date(now + 5 * 60 * 60 * 1000 - 3000), // 3s elapsed
    };
    const { line2 } = capture({ stdin: baseStdin, usage: justReset, git: null, now });
    const fhSection = line2.split('snt:')[0];
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
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 50, creditGrant: null },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: withExtra, git: null, now });
    assert.ok(line3.includes('●$:'), '●$: label missing');
    assert.ok(line3.includes('$50'), 'current spend missing');
    assert.ok(line3.includes('$500'), 'limit missing');
  });

  test('shows pace glyph and projected spend', () => {
    const withExtra: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 50, creditGrant: null },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: withExtra, git: null, now });
    const afterDollar = line3.split('$:')[1] ?? '';
    const hasGlyph = afterDollar.includes('↘') || afterDollar.includes('→') || afterDollar.includes('↗');
    assert.ok(hasGlyph, 'pace glyph missing from extra usage');
  });

  test('$0 spent still shows pace (projected $0)', () => {
    const zeroed: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 0, creditGrant: null },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: zeroed, git: null, now });
    assert.ok(line3.includes('●$:'), '●$: label missing');
    assert.ok(line3.includes('$0'), '$0 spend missing');
  });

  // U1: the disabled placeholder used to be 4 visible chars (' ○$:'),
  // then 9 (added " off"). At full tier neighbouring quota segments
  // are 32 visible chars, so the disabled stub left an obvious gap.
  // Now padded to the active tier's width so all segments align.
  test('disabled extras placeholder pads to the active tier width (full tier)', () => {
    const disabled: UsageData = {
      ...baseUsage,
      // Force line 3 to render: opus is non-null so hasLine3 is true.
      opus: 5, opusResetAt: in3d,
      extraUsage: { enabled: false },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: disabled, git: null, now, columns: 200 });
    // ' ○$:' + ' ' + ' off' = 9 chars; full-tier padding adds 23 trailing spaces.
    assert.ok(line3.includes('○$:'), 'disabled label still rendered');
    assert.ok(line3.includes('off'), 'off marker still rendered');
    // The trailing spaces are between 'off' and the line end (or the
    // syncHint). Asserting the full line ends in spaces past the marker
    // is enough — neighbour quotas still occupy 32 chars apiece.
    const offIdx = line3.lastIndexOf('off');
    assert.ok(offIdx >= 0);
    const tail = line3.slice(offIdx + 3);
    assert.ok(/^\s+/.test(tail), `expected trailing padding after "off", got: "${tail}"`);
  });
});

// ── credit grant balance ──────────────────────────────────────────────────

describe('credit grant balance', () => {
  test('shows balance when creditGrant is present', () => {
    const withGrant: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 50, creditGrant: 1000 },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: withGrant, git: null, now });
    assert.ok(line3.includes('$950'), 'balance $950 should appear');
  });

  test('hides balance when creditGrant is null', () => {
    const noGrant: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 50, creditGrant: null },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: noGrant, git: null, now });
    assert.ok(!line3.includes('('), 'no balance parens when creditGrant is null');
  });

  test('shows cents for small balances', () => {
    const smallGrant: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 495, creditGrant: 500 },
    };
    const { line3 } = capture({ stdin: baseStdin, usage: smallGrant, git: null, now });
    assert.ok(line3.includes('$5.00'), 'should show $5.00 balance with cents');
  });
});

describe('formatBalance', () => {
  test('returns $0 when fully spent', () => {
    assert.equal(formatBalance(100, 100), '$0');
  });

  test('returns $0 when overspent', () => {
    assert.equal(formatBalance(100, 150), '$0');
  });

  test('shows cents for balances under $10', () => {
    assert.equal(formatBalance(10, 1.42), '$8.58');
  });

  test('shows whole dollars for balances $10–$99', () => {
    assert.equal(formatBalance(100, 5.42), '$95');
  });

  test('uses formatMoney for balances >= $100', () => {
    assert.equal(formatBalance(1000, 5), '$995');
  });

  test('shows cents for small balances', () => {
    assert.equal(formatBalance(100, 99.50), '$0.50');
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
    // Bare ⚠ glyph — same presentation as rows=1 and the syncHint path.
    assert.ok(line2.includes('⚠'), 'unavailable indicator missing');
    assert.ok(!line2.includes('usage:'), '"usage:" prefix removed for consistency');
    assert.ok(line2.includes('max'), 'plan name missing from unavailable line');
  });
});

// ── height-adaptive rendering ──────────────────────────────────────────────

describe('height-adaptive rendering', () => {
  test('rows=3 produces three lines', () => {
    const { line1, line2, line3 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, rows: 3 });
    assert.ok(line1 !== '', 'line 1 must be present');
    assert.ok(line2 !== '', 'line 2 must be present');
    assert.ok(line3 !== '', 'line 3 must be present');
  });

  test('rows=3 line 2 has 5h and snt only; line 3 has 7d', () => {
    const { line2, line3 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, rows: 3 });
    assert.ok(line2.includes('5h:'), '5h should be on line 2');
    assert.ok(line2.includes('snt:'), 'snt should be on line 2');
    assert.ok(!line2.includes('7d:'), '7d should not be on line 2 at rows=3');
    assert.ok(line3.includes('7d:'), '7d should be on line 3 at rows=3');
  });

  test('rows=2 produces exactly two lines', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    render({ stdin: baseStdin, usage: baseUsage, git: null, now, rows: 2 });
    console.log = orig;
    assert.equal(lines.length, 2, 'rows=2 must produce exactly 2 lines');
  });

  test('rows=2 line 2 contains all quotas (5h, 7d, snt) on one line', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    render({ stdin: baseStdin, usage: baseUsage, git: null, now, rows: 2 });
    console.log = orig;
    const line2 = lines[1]?.replace(/\x1b\[[0-9;]*m/g, '') ?? '';
    assert.ok(line2.includes('5h:'), '5h missing from rows=2 line 2');
    assert.ok(line2.includes('7d:'), '7d missing from rows=2 line 2');
    assert.ok(line2.includes('snt:'), 'snt missing from rows=2 line 2 (should be merged)');
  });

  test('rows=1 produces exactly one line', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    render({ stdin: baseStdin, usage: baseUsage, git: null, now, rows: 1 });
    console.log = orig;
    assert.equal(lines.length, 1, 'rows=1 must produce exactly 1 line');
  });

  test('rows=1 line shows model, ctx, and quota percentages', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, rows: 1 });
    assert.ok(line1.includes('sonnet'), 'model name missing from rows=1');
    assert.ok(line1.includes('ctx:'), 'ctx label missing from rows=1');
    assert.ok(line1.includes('5h:'), '5h label missing from rows=1');
    assert.ok(line1.includes('7d:'), '7d label missing from rows=1');
  });

  test('rows=1 line does not include git branch (quota info takes priority)', () => {
    const { line1 } = capture({
      stdin: baseStdin, usage: baseUsage,
      git: { branch: 'feature-xyz', isDirty: false }, now, rows: 1,
    });
    assert.ok(!line1.includes('feature-xyz'), 'git branch should not appear in rows=1');
  });

  test('rows=1 line does not contain ctx bar chars', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, rows: 1 });
    // At rows=1, ctx uses compact form (label + pct, no bar)
    assert.ok(!line1.includes('█'), 'ctx bar should not appear in rows=1');
  });

  test('rows=1 line never exceeds column width', () => {
    const widths = [20, 33, 47, 57, 80, 120];
    for (const columns of widths) {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(' '));
      render({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, rows: 1, columns });
      console.log = orig;
      assert.equal(lines.length, 1, `rows=1 must produce 1 line at columns=${columns}`);
      const visible = vlen(lines[0] ?? '');
      assert.ok(visible <= columns, `visible length ${visible} exceeds columns=${columns}`);
    }
  });
});

// ── width-adaptive rendering ───────────────────────────────────────────────
//
// Thresholds are derived from the baseStdin + baseUsage fixture:
//   col0Width = max("sonnet high" + " ⧉"=13, "max"=3, fetchTime=6) = 13
//     The dashboard link " ⧉" is pinned to line 1's model prefix and is
//     part of the always-rendered col-0 column on every line.
//   ctx segment visible width = 19
//   SEP " │ " = 3
//
//   Line 1 (model+link │ ctx │ git):
//     full / no-reset: 13+3+19+3+21 = 59  (git = "my-project git:(main)" = 21)
//     no-pace:         13+3+19+3+10 = 48  (git = "my-project" = 10)
//     compact:         13+3+19      = 35  (git omitted)
//
//   Line 2 (plan │ 5h │ snt), each quota at each tier:
//     full:      13+3+32+3+32 = 83
//     no-reset:  13+3+25+3+25 = 69
//     no-pace:   13+3+19+3+19 = 57
//     compact:   13+3+ 9+3+ 9 = 37

const baseGit = { branch: 'main', isDirty: false };

describe('width-adaptive rendering', () => {
  // ── line 2 tier boundaries ──────────────────────────────────────────────

  test('line 2 shows reset timer at exactly the full-tier width', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 83 });
    assert.ok(/[○◔◑◕●]/.test(line2), 'reset circle glyph should be present at full width');
  });

  test('line 2 drops reset timer one column below full-tier width', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 82 });
    assert.ok(!/[○◔◑◕●]/.test(line2), 'reset circle glyph should be dropped below full-tier width');
    const hasGlyph = line2.includes('↘') || line2.includes('→') || line2.includes('↗');
    assert.ok(hasGlyph, 'pace glyph should still be present in no-reset tier');
  });

  test('line 2 shows pace glyph at exactly the no-reset-tier width', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 69 });
    const hasGlyph = line2.includes('↘') || line2.includes('→') || line2.includes('↗');
    assert.ok(hasGlyph, 'pace glyph should be present at no-reset-tier width');
  });

  test('line 2 drops pace glyph one column below no-reset-tier width', () => {
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 68 });
    assert.ok(!/[○◔◑◕●]/.test(line2), 'reset circle glyph should be absent');
    const hasGlyph = line2.includes('↘') || line2.includes('→') || line2.includes('↗');
    assert.ok(!hasGlyph, 'pace glyph should be dropped below no-reset-tier width');
    assert.ok(line2.includes('█') || line2.includes('░'), 'bar chars should still be present');
  });

  test('line 2 drops bars in compact tier', () => {
    // compact tier renders 37 visible chars exactly; use columns=37 to avoid hard truncation
    const { line2 } = capture({ stdin: baseStdin, usage: baseUsage, git: null, now, columns: 37 });
    assert.ok(!line2.includes('█') && !line2.includes('░'), 'bar chars should be absent in compact tier');
    assert.ok(line2.includes('36%'), '5h percentage must still be visible');
    assert.ok(line2.includes('56%'), 'snt percentage must still be visible');
  });

  // ── line 1 git degradation ──────────────────────────────────────────────

  test('line 1 shows branch at exactly the full-tier width', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns: 59 });
    assert.ok(line1.includes('main'), 'branch should be present at full-tier width');
  });

  test('line 1 drops branch one column below full-tier width', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns: 58 });
    assert.ok(!line1.includes('main'), 'branch should be dropped below full-tier width');
    assert.ok(line1.includes('my-project'), 'project name should still be present');
  });

  test('line 1 drops project name below no-pace-tier width', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns: 47 });
    assert.ok(!line1.includes('my-project'), 'project should be dropped below no-pace-tier width');
    assert.ok(line1.includes('sonnet'), 'model name must remain');
  });

  // ── dashboard link segment ───────────────────────────────────────────────

  test('line 1 shows the dashboard OSC 8 link at a wide terminal', () => {
    // Wide terminal → full tier → link rendered after the model prefix.
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    render({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns: 120 });
    console.log = orig;

    const rawLine1 = lines[0] ?? '';
    assert.ok(rawLine1.includes('\x1b]8;;file://'),
      'OSC 8 hyperlink opener should appear on line 1 at 120 cols');
    assert.ok(rawLine1.includes('dashboard.html'),
      'link target should be dashboard.html');
    assert.ok(rawLine1.includes('\x1b]8;;\x1b\\'),
      'OSC 8 link closer must be present');
  });

  test('line 1 keeps the dashboard link visible at every tier (pinned to model prefix)', () => {
    // The link used to be the first thing dropped when width tightened —
    // it's now an always-on UI affordance attached to the model prefix.
    for (const columns of [120, 80, 59, 48, 35, 25]) {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(' '));
      render({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns });
      console.log = orig;
      const rawLine1 = lines[0] ?? '';
      assert.ok(rawLine1.includes('\x1b]8;;file://'),
        `link must remain visible at columns=${columns}; got: ${strip(rawLine1)}`);
    }
  });

  test('line 1 visible length still respects column width with link present', () => {
    // Regression: forgetting to strip OSC 8 in visibleLength would blow
    // past the width cap without fitLine noticing.
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    render({ stdin: baseStdin, usage: baseUsage, git: baseGit, now, columns: 120 });
    console.log = orig;
    const v = vlen(lines[0] ?? '');
    assert.ok(v <= 120, `line 1 visible length ${v} must not exceed 120`);
  });

  // ── line length invariant ───────────────────────────────────────────────

  test('no line exceeds the specified column width (invariant across many widths)', () => {
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

// ── line 3 width-adaptive rendering ───────────────────────────────────────
//
// Thresholds for line 3 with 7d + extra usage (opus=null):
//   col0Width = 11, each quota tier width: full=32, no-reset=25, no-pace=19, compact=9
//   SEP = 3
//
//   full:      11+3+32+3+32 = 81  (7d full + extra full; includes /$limit)
//   no-reset:  11+3+25+3+25 = 67  (/$limit dropped; pace glyph kept)
//   no-pace:   11+3+19+3+19 = 55  (pace glyph dropped; bars kept)
//   compact:   11+3+ 9+3+ 9 = 35  (bars dropped; label+value only)

const usageWithExtra: UsageData = {
  ...baseUsage,
  extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 50, creditGrant: null },
  fetchedAt: now,
};

describe('line 3 width-adaptive rendering', () => {
  test('shows monthly limit in line 3 at exactly the full-tier width', () => {
    const { line3 } = capture({ stdin: baseStdin, usage: usageWithExtra, git: null, now, columns: 83 });
    assert.ok(line3.includes('/$500'), 'monthly limit should be present at full-tier width');
  });

  test('drops monthly limit in line 3 one column below full-tier width', () => {
    const { line3 } = capture({ stdin: baseStdin, usage: usageWithExtra, git: null, now, columns: 82 });
    assert.ok(!line3.includes('/$500'), 'monthly limit should be dropped below full-tier width');
    const hasGlyph = line3.includes('↘') || line3.includes('→') || line3.includes('↗');
    assert.ok(hasGlyph, 'pace glyph should still be present in no-reset tier');
  });

  test('shows pace glyph in line 3 at exactly the no-reset-tier width', () => {
    const { line3 } = capture({ stdin: baseStdin, usage: usageWithExtra, git: null, now, columns: 69 });
    const hasGlyph = line3.includes('↘') || line3.includes('→') || line3.includes('↗');
    assert.ok(hasGlyph, 'pace glyph should be present at no-reset-tier width');
  });

  test('drops pace glyph in line 3 one column below no-reset-tier width', () => {
    const { line3 } = capture({ stdin: baseStdin, usage: usageWithExtra, git: null, now, columns: 68 });
    const hasGlyph = line3.includes('↘') || line3.includes('→') || line3.includes('↗');
    assert.ok(!hasGlyph, 'pace glyph should be dropped below no-reset-tier width');
    assert.ok(line3.includes('█') || line3.includes('░'), 'bar chars should still be present');
  });

  test('no line 3 exceeds column width (invariant with extra usage enabled)', () => {
    // Extra usage widens line 3 to 81 at full tier; test all tier boundaries.
    const widths = [20, 35, 55, 66, 67, 80, 81, 120];
    for (const columns of widths) {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(' '));
      render({ stdin: baseStdin, usage: usageWithExtra, git: null, now, columns });
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

  test('no line exceeds column width when credit grant balance is shown', () => {
    const withGrant: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 50, creditGrant: 1000 },
      fetchedAt: now,
    };
    const widths = [20, 35, 55, 66, 67, 80, 81, 95, 120];
    for (const columns of widths) {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(' '));
      render({ stdin: baseStdin, usage: withGrant, git: null, now, columns });
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

// ── git dirty-marker degradation ──────────────────────────────────────────
//
// With git { branch: 'main', isDirty: true }:
//   renderGit full:    "my-project git:(main*)"  = 22 visible chars
//   Line 1 full:       13+3+19+3+22 = 60
//   renderGit no-pace: "my-project"              = 10 visible chars
//   Line 1 no-pace:    13+3+19+3+10 = 48

describe('git dirty-marker degradation', () => {
  const dirtyGit = { branch: 'main', isDirty: true };

  test('dirty marker and branch present at full-tier width', () => {
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: dirtyGit, now, columns: 60 });
    assert.ok(line1.includes('main*'), 'dirty branch should appear at full-tier width');
  });

  test('dirty marker absent when branch is dropped at no-pace tier', () => {
    // At columns=59, full (60) > 59 and no-reset (60) > 59, so no-pace (48) is used.
    // no-pace renders project only — branch and dirty marker must not appear.
    const { line1 } = capture({ stdin: baseStdin, usage: baseUsage, git: dirtyGit, now, columns: 59 });
    assert.ok(line1.includes('my-project'), 'project should still appear');
    assert.ok(!line1.includes('main'), 'branch should not appear at no-pace tier');
    assert.ok(!line1.includes('*'), 'dirty marker must not appear without branch');
  });
});

// ── height-adaptive edge cases ─────────────────────────────────────────────

describe('height-adaptive edge cases', () => {
  test('rows=1 omits 5h when fiveHour is null, keeps 7d', () => {
    const noFiveHour: UsageData = { ...baseUsage, fiveHour: null, fiveHourResetAt: null };
    const { line1 } = capture({ stdin: baseStdin, usage: noFiveHour, git: null, now, rows: 1 });
    assert.ok(!line1.includes('5h:'), '5h segment should be absent when null');
    assert.ok(line1.includes('7d:'), '7d segment should still be present');
  });

  test('rows=1 shows only model and ctx when both quotas are null', () => {
    const noQuotas: UsageData = {
      ...baseUsage, fiveHour: null, fiveHourResetAt: null,
      sevenDay: null, sevenDayResetAt: null,
    };
    const { line1 } = capture({ stdin: baseStdin, usage: noQuotas, git: null, now, rows: 1 });
    assert.ok(line1.includes('sonnet'), 'model name must appear');
    assert.ok(line1.includes('ctx:'), 'ctx label must appear');
    assert.ok(!line1.includes('5h:'), '5h should not appear');
    assert.ok(!line1.includes('7d:'), '7d should not appear');
  });

  test('rows=1 with usage=null collapses to compact model + ctx (no bar, no git)', () => {
    // CLAUDE.md spec: rows=1 emits model + compact ctx% + 5h% + 7d%, never
    // a bar or git block. The previous fallback path delegated to the
    // multi-row builder when usage was null, leaking a bar onto line 1.
    const { line1 } = capture({ stdin: baseStdin, usage: null, git: { branch: 'main', isDirty: false }, now, rows: 1 });
    assert.ok(line1.includes('sonnet'), 'model name must appear');
    assert.ok(line1.includes('ctx:'), 'ctx label must appear');
    assert.ok(!line1.includes('█'), 'ctx bar must NOT appear at rows=1 (compact only)');
    assert.ok(!line1.includes('5h:'), '5h should not appear without usage');
    assert.ok(!line1.includes('git:'), 'git block must not appear at rows=1');
  });

  test('rows=1 with apiUnavailable usage also stays compact (no bar)', () => {
    const failed: UsageData = {
      ...baseUsage,
      fiveHour: null, fiveHourResetAt: null,
      sevenDay: null, sevenDayResetAt: null,
      sonnet: null, sonnetResetAt: null,
      apiUnavailable: true,
    };
    const { line1 } = capture({ stdin: baseStdin, usage: failed, git: null, now, rows: 1 });
    assert.ok(!line1.includes('█'), 'ctx bar must not appear when API is unavailable at rows=1');
  });

  // Consistency: at rows=1 the user should see the same API-status indicator
  // they'd get at rows=3, so a rate-limit incident isn't invisible just
  // because the terminal is short.
  test('rows=1 surfaces ⟳ when the API is rate-limited', () => {
    const rateLimited: UsageData = { ...baseUsage, apiError: 'rate-limited' };
    const { line1 } = capture({ stdin: baseStdin, usage: rateLimited, git: null, now, rows: 1 });
    assert.ok(line1.includes('⟳'), 'rate-limit indicator must appear on rows=1');
  });

  test('rows=1 surfaces ⚠ when the API is otherwise unavailable', () => {
    const failed: UsageData = {
      ...baseUsage,
      fiveHour: null, sevenDay: null, sonnet: null,
      apiUnavailable: true,
      apiError: 'http-500',
    };
    const { line1 } = capture({ stdin: baseStdin, usage: failed, git: null, now, rows: 1 });
    assert.ok(line1.includes('⚠'), 'failure indicator must appear on rows=1');
  });

  test('rows=1 with API hint never exceeds column width', () => {
    const rateLimited: UsageData = { ...baseUsage, apiError: 'rate-limited' };
    for (const columns of [25, 35, 47, 80, 120]) {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(' '));
      try {
        render({ stdin: baseStdin, usage: rateLimited, git: null, now, rows: 1, columns });
      } finally {
        console.log = orig;
      }
      const v = vlen(lines[0] ?? '');
      assert.ok(v <= columns, `rows=1 + ⟳ hint visible ${v} > ${columns}: "${lines[0]?.replace(/\x1b\[[0-9;]*m/g, '')}"`);
    }
  });

  test('rows=2 appends rate-limited indicator to the merged quota line', () => {
    const rateLimited: UsageData = { ...baseUsage, apiError: 'rate-limited' };
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    render({ stdin: baseStdin, usage: rateLimited, git: null, now, rows: 2 });
    console.log = orig;
    assert.equal(lines.length, 2, 'should produce exactly 2 lines');
    const line2 = lines[1]?.replace(/\x1b\[[0-9;]*m/g, '') ?? '';
    assert.ok(line2.includes('⟳'), 'rate-limited indicator must be on line 2 at rows=2');
  });

  test('rows=2 width invariant (merged line never exceeds columns)', () => {
    // rows=2 merged line: plan + 5h + 7d + snt — wider than individual lines at rows=3.
    // With baseUsage (opus=null, extra=null):
    //   full:     11+3+32+3+32+3+32 = 116
    //   no-reset: 11+3+25+3+25+3+25 =  95
    //   no-pace:  11+3+19+3+19+3+19 =  77
    //   compact:  11+3+ 9+3+ 9+3+ 9 =  47
    const widths = [20, 47, 55, 77, 80, 95, 116, 120];
    for (const columns of widths) {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(' '));
      render({ stdin: baseStdin, usage: baseUsage, git: null, now, rows: 2, columns });
      console.log = orig;
      for (const line of lines) {
        const visible = vlen(line);
        assert.ok(
          visible <= columns,
          `rows=2 line visible length ${visible} exceeds columns=${columns}: "${line.replace(/\x1b\[[0-9;]*m/g, '')}"`,
        );
      }
    }
  });

  // Regression: pad0 used to do ' '.repeat(col0Width - text.length) without
  // clamping to 0. When the model display ("opus") and plan ("Max") were both
  // shorter than the 6-char fetchTime stamp, line 3 attempted ' '.repeat(-2)
  // and threw RangeError — caught by main()'s try/catch, so the user saw an
  // empty statusline.
  test('does not crash when col0Width is shorter than the fetch-time stamp', () => {
    const shortStdin = {
      model: { display_name: 'Claude Opus 4.6' }, // family "opus" = 4 chars
      // no effort_level — keeps modelText at 4 chars
      context_window: { current_usage: { input_tokens: 40_000 }, context_window_size: 200_000 },
      cwd: '/home/user/p',
    };
    const usage: UsageData = {
      ...baseUsage,
      planName: 'Max', // 3 chars → col0Width = max(4, 3) = 4 < 6 (fetch-time width)
      fetchedAt: now,
    };
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      assert.doesNotThrow(
        () => render({ stdin: shortStdin, usage, git: null, now, rows: 3 }),
        'render must not throw RangeError when col0Width < fetch-time length',
      );
    } finally {
      console.log = orig;
    }
    // Sanity: 3 lines should still be produced.
    assert.equal(lines.length, 3, 'expected three lines at rows=3');
  });

  test('rate-limited indicator never pushes any line past the terminal width', () => {
    // Before the syncHint fix, fitLine sized the line to `cols` and then
    // syncHint (' ⟳', 2 visible chars) was appended — causing overflow.
    const rateLimited: UsageData = { ...baseUsage, apiError: 'rate-limited' };
    const widths = [35, 55, 67, 81, 95, 120];
    for (const columns of widths) {
      for (const rows of [2, 3] as const) {
        const lines: string[] = [];
        const orig = console.log;
        console.log = (...args: unknown[]) => lines.push(args.join(' '));
        render({ stdin: baseStdin, usage: rateLimited, git: null, now, columns, rows });
        console.log = orig;
        for (const line of lines) {
          const visible = vlen(line);
          assert.ok(
            visible <= columns,
            `rate-limited line visible length ${visible} exceeds columns=${columns} at rows=${rows}: "${line.replace(/\x1b\[[0-9;]*m/g, '')}"`,
          );
        }
      }
    }
  });
});
