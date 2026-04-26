import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getModelName, getContextPercent, getProjectName, getEffortLevel,
  parseStdinPayload, STDIN_MAX_BYTES, PROJECT_NAME_MAX,
} from '../src/stdin.js';
import type { StdinData } from '../src/types.js';

describe('getModelName', () => {
  test('returns display_name when present', () => {
    const stdin: StdinData = { model: { display_name: 'Sonnet 4.6' } };
    assert.equal(getModelName(stdin), 'Sonnet 4.6');
  });

  test('returns fallback when model is absent', () => {
    assert.equal(getModelName({}), 'Claude');
  });

  test('returns fallback when display_name is absent', () => {
    assert.equal(getModelName({ model: {} }), 'Claude');
  });

  // Defends against `model.display_name` being a non-string at render time
  // — would have thrown inside extractFamily's `.replace`.
  test('returns fallback for non-string display_name', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(getModelName({ model: { display_name: 42 } } as any), 'Claude');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(getModelName({ model: { display_name: { name: 'x' } } } as any), 'Claude');
  });
});

describe('getContextPercent', () => {
  test('calculates total token usage as percentage', () => {
    const stdin: StdinData = {
      context_window: {
        current_usage: { input_tokens: 50_000 },
        context_window_size: 200_000,
      },
    };
    assert.equal(getContextPercent(stdin), 25);
  });

  test('sums all token types', () => {
    const stdin: StdinData = {
      context_window: {
        current_usage: {
          input_tokens: 40_000,
          cache_creation_input_tokens: 20_000,
          cache_read_input_tokens: 10_000,
          output_tokens: 10_000,
        },
        context_window_size: 200_000,
      },
    };
    assert.equal(getContextPercent(stdin), 40);
  });

  test('returns 0 when context_window is absent', () => {
    assert.equal(getContextPercent({}), 0);
  });

  test('returns 0 when context_window_size is 0', () => {
    const stdin: StdinData = {
      context_window: {
        current_usage: { input_tokens: 10_000 },
        context_window_size: 0,
      },
    };
    assert.equal(getContextPercent(stdin), 0);
  });

  test('clamps to 100 on overflow', () => {
    const stdin: StdinData = {
      context_window: {
        current_usage: { input_tokens: 300_000 },
        context_window_size: 200_000,
      },
    };
    assert.equal(getContextPercent(stdin), 100);
  });

  test('rounds to nearest integer', () => {
    const stdin: StdinData = {
      context_window: {
        current_usage: { input_tokens: 1 },
        context_window_size: 3,
      },
    };
    // 1/3 = 33.33... → rounds to 33
    assert.equal(getContextPercent(stdin), 33);
  });

  // Hardening: hostile/buggy stdin must not produce negative or NaN
  // percentages that leak into the render layer.
  test('clamps negative token counts to 0', () => {
    const stdin = {
      context_window: {
        current_usage: { input_tokens: -1_000_000 as unknown as number },
        context_window_size: 200_000,
      },
    } as StdinData;
    assert.equal(getContextPercent(stdin), 0);
  });

  test('ignores non-numeric token fields rather than producing NaN', () => {
    const stdin = {
      context_window: {
        current_usage: { input_tokens: 'lots' as unknown as number },
        context_window_size: 200_000,
      },
    } as StdinData;
    assert.equal(getContextPercent(stdin), 0);
  });

  test('returns 0 for non-finite context_window_size', () => {
    const stdinInf = {
      context_window: {
        current_usage: { input_tokens: 1_000 },
        context_window_size: Infinity as unknown as number,
      },
    } as StdinData;
    assert.equal(getContextPercent(stdinInf), 0);

    const stdinNaN = {
      context_window: {
        current_usage: { input_tokens: 1_000 },
        context_window_size: NaN as unknown as number,
      },
    } as StdinData;
    assert.equal(getContextPercent(stdinNaN), 0);
  });

  test('returns 0 for negative context_window_size', () => {
    const stdin = {
      context_window: {
        current_usage: { input_tokens: 1_000 },
        context_window_size: -1 as unknown as number,
      },
    } as StdinData;
    assert.equal(getContextPercent(stdin), 0);
  });
});

describe('getProjectName', () => {
  test('returns last path segment on Unix', () => {
    const stdin: StdinData = { cwd: '/Users/md/dev/my-project' };
    assert.equal(getProjectName(stdin), 'my-project');
  });

  test('returns last path segment on Windows-style path', () => {
    const stdin: StdinData = { cwd: 'C:\\Users\\md\\dev\\my-project' };
    assert.equal(getProjectName(stdin), 'my-project');
  });

  test('returns null when cwd is absent', () => {
    assert.equal(getProjectName({}), null);
  });

  test('returns null for empty cwd', () => {
    assert.equal(getProjectName({ cwd: '' }), null);
  });

  test('handles root path gracefully', () => {
    const stdin: StdinData = { cwd: '/' };
    assert.equal(getProjectName(stdin), null);
  });

  // U3: long project names previously rendered verbatim and could push
  // line 1 layout into compact tier at unexpectedly wide terminals.
  test('truncates names longer than the max with an ellipsis', () => {
    const longName = 'a'.repeat(40);
    const stdin: StdinData = { cwd: `/home/user/${longName}` };
    const result = getProjectName(stdin);
    assert.equal(result?.length, PROJECT_NAME_MAX);
    assert.ok(result?.endsWith('…'), 'truncated name must end with an ellipsis');
  });

  test('does not truncate names at exactly the max length', () => {
    const exact = 'b'.repeat(PROJECT_NAME_MAX);
    const stdin: StdinData = { cwd: `/home/user/${exact}` };
    assert.equal(getProjectName(stdin), exact);
  });

  // Regression: a non-string cwd (number, object, array) used to crash
  // .split() because the truthiness guard `!stdin.cwd` lets a truthy
  // non-string through. Mirrors the typeof guard already in getModelName /
  // getEffortLevel.
  test('returns null for non-string cwd values', () => {
    assert.equal(getProjectName({ cwd: 42 } as unknown as StdinData), null);
    assert.equal(getProjectName({ cwd: ['a', 'b'] } as unknown as StdinData), null);
    assert.equal(getProjectName({ cwd: { path: '/x' } } as unknown as StdinData), null);
    assert.equal(getProjectName({ cwd: true } as unknown as StdinData), null);
  });
});

describe('parseStdinPayload', () => {
  test('parses a valid payload', () => {
    const parsed = parseStdinPayload('{"model":{"display_name":"Sonnet 4.6"}}');
    assert.ok(parsed);
    assert.equal(parsed.model?.display_name, 'Sonnet 4.6');
  });

  test('tolerates surrounding whitespace', () => {
    const parsed = parseStdinPayload('  \n {"cwd":"/tmp"}  \n');
    assert.equal(parsed?.cwd, '/tmp');
  });

  test('returns null for malformed JSON', () => {
    assert.equal(parseStdinPayload('{not json'), null);
    assert.equal(parseStdinPayload(''), null);
    assert.equal(parseStdinPayload('undefined'), null);
  });

  test('rejects JSON arrays (must be an object)', () => {
    assert.equal(parseStdinPayload('[]'), null);
    assert.equal(parseStdinPayload('[1,2,3]'), null);
  });

  test('rejects JSON primitives', () => {
    assert.equal(parseStdinPayload('42'), null);
    assert.equal(parseStdinPayload('"hello"'), null);
    assert.equal(parseStdinPayload('true'), null);
    assert.equal(parseStdinPayload('null'), null);
  });

  test('rejects payloads larger than STDIN_MAX_BYTES without parsing', () => {
    // Build a valid-JSON oversized payload. Even though JSON.parse would
    // succeed, the size guard must reject first to bound memory usage.
    const oversized = '{"cwd":"' + 'x'.repeat(STDIN_MAX_BYTES) + '"}';
    assert.ok(oversized.length > STDIN_MAX_BYTES);
    assert.equal(parseStdinPayload(oversized), null);
  });

  test('accepts payloads at exactly the size cap', () => {
    // Construct a payload equal to or just under the cap — must succeed.
    const filler = 'x'.repeat(STDIN_MAX_BYTES - 20);
    const payload = `{"cwd":"${filler}"}`;
    assert.ok(payload.length <= STDIN_MAX_BYTES);
    const parsed = parseStdinPayload(payload);
    assert.ok(parsed);
    assert.equal(parsed.cwd?.length, filler.length);
  });
});

describe('getEffortLevel', () => {
  test('reads effort_level (snake_case)', () => {
    assert.equal(getEffortLevel({ effort_level: 'high' }), 'high');
  });

  test('reads effortLevel (camelCase) as fallback', () => {
    assert.equal(getEffortLevel({ effortLevel: 'medium' }), 'medium');
  });

  test('prefers effort_level over effortLevel when both present', () => {
    assert.equal(getEffortLevel({ effort_level: 'high', effortLevel: 'low' }), 'high');
  });

  test('reads effort (no-underscore) as fallback', () => {
    assert.equal(getEffortLevel({ effort: 'low' }), 'low');
  });

  test('returns null when absent', () => {
    assert.equal(getEffortLevel({}), null);
  });

  // Claude Code on Windows has been observed sending an object here; the
  // raw value used to flow into render.ts where `.toLowerCase()` threw.
  test('returns null for non-string values', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(getEffortLevel({ effort_level: { level: 'high' } } as any), null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(getEffortLevel({ effort_level: 7 } as any), null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(getEffortLevel({ effort_level: true } as any), null);
  });

  test('returns null for empty string', () => {
    assert.equal(getEffortLevel({ effort_level: '' }), null);
  });
});
