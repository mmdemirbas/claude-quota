import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/render.js';
import type { RenderInput } from '../src/render.js';
import type { UsageData } from '../src/types.js';

/** Strip ANSI escape codes for plain-text assertions. */
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function capture(input: RenderInput): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  render(input);
  console.log = orig;
  return strip(lines.join('\n'));
}

const baseStdin = {
  model: { display_name: 'Sonnet 4.6' },
  context_window: {
    current_usage: { input_tokens: 40_000 },
    context_window_size: 200_000,
  },
  cwd: '/home/user/my-project',
};

const baseUsage: UsageData = {
  planName: 'Max',
  fiveHour: 36,
  fiveHourResetAt: null,
  sevenDay: 18,
  sevenDayResetAt: null,
  sonnet: 56,
  sonnetResetAt: null,
  opus: null,
  opusResetAt: null,
  extraUsage: null,
};

describe('render', () => {
  test('includes model and plan', () => {
    const out = capture({ stdin: baseStdin, usage: baseUsage, git: null });
    assert.ok(out.includes('Sonnet 4.6'), 'model name missing');
    assert.ok(out.includes('Max'), 'plan name missing');
  });

  test('includes context percentage', () => {
    const out = capture({ stdin: baseStdin, usage: baseUsage, git: null });
    assert.ok(out.includes('20%'), 'context percentage missing');
  });

  test('includes project name from cwd', () => {
    const out = capture({ stdin: baseStdin, usage: baseUsage, git: null });
    assert.ok(out.includes('my-project'), 'project name missing');
  });

  test('includes quota values', () => {
    const out = capture({ stdin: baseStdin, usage: baseUsage, git: null });
    assert.ok(out.includes('5h:'), '5h label missing');
    assert.ok(out.includes('36%'), '5h value missing');
    assert.ok(out.includes('7d:'), '7d label missing');
    assert.ok(out.includes('18%'), '7d value missing');
    assert.ok(out.includes('snt:'), 'sonnet label missing');
    assert.ok(out.includes('56%'), 'sonnet value missing');
  });

  test('includes git branch when provided', () => {
    const out = capture({
      stdin: baseStdin,
      usage: baseUsage,
      git: { branch: 'main', isDirty: false },
    });
    assert.ok(out.includes('main'), 'branch missing');
    assert.ok(!out.includes('main*'), 'dirty marker should be absent');
  });

  test('marks dirty git repo with asterisk', () => {
    const out = capture({
      stdin: baseStdin,
      usage: baseUsage,
      git: { branch: 'feature', isDirty: true },
    });
    assert.ok(out.includes('feature*'), 'dirty marker missing');
  });

  test('shows rate-limited indicator when quotas are available', () => {
    const rateLimited: UsageData = { ...baseUsage, apiError: 'rate-limited' };
    const out = capture({ stdin: baseStdin, usage: rateLimited, git: null });
    assert.ok(out.includes('⟳'), 'rate-limited indicator missing');
  });

  test('shows rate-limited indicator when all quotas are null', () => {
    const rateLimited: UsageData = {
      ...baseUsage,
      fiveHour: null, sevenDay: null, sonnet: null, opus: null,
      apiError: 'rate-limited',
    };
    const out = capture({ stdin: baseStdin, usage: rateLimited, git: null });
    assert.ok(out.includes('⟳'), 'rate-limited indicator missing when quotas are all null');
  });

  test('shows warning indicator on API unavailable', () => {
    const unavailable: UsageData = {
      ...baseUsage,
      fiveHour: null, sevenDay: null, sonnet: null, opus: null,
      apiUnavailable: true,
      apiError: 'network',
    };
    const out = capture({ stdin: baseStdin, usage: unavailable, git: null });
    assert.ok(out.includes('usage:⚠'), 'unavailable indicator missing');
  });

  test('shows extra usage when enabled', () => {
    const withExtra: UsageData = {
      ...baseUsage,
      extraUsage: { enabled: true, monthlyLimit: 500, usedCredits: 12 },
    };
    const out = capture({ stdin: baseStdin, usage: withExtra, git: null });
    assert.ok(out.includes('$12'), 'used credits missing');
    assert.ok(out.includes('$500'), 'monthly limit missing');
  });

  test('renders without usage data', () => {
    const out = capture({ stdin: baseStdin, usage: null, git: null });
    assert.ok(out.includes('Sonnet 4.6'), 'model missing when usage is null');
  });
});
