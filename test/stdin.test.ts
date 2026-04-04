import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getModelName, getContextPercent, getProjectName } from '../src/stdin.js';
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
});
