import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { warn } from '../src/log.js';

// Intercept process.stderr.write so we can assert on the emitted line
// without actually polluting the test runner output. We replace the
// method instead of setting env FD tricks so the test stays cross-platform.

interface StderrIntercept {
  captured: string[];
  restore: () => void;
}

function interceptStderr(): StderrIntercept {
  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // The real signature accepts many overloads; we only care about strings.
  process.stderr.write = ((chunk: unknown): boolean => {
    if (typeof chunk === 'string') captured.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    captured,
    restore: () => { process.stderr.write = original; },
  };
}

describe('warn', () => {
  let intercept: StderrIntercept;
  let prevSilent: string | undefined;

  beforeEach(() => {
    prevSilent = process.env['CLAUDE_QUOTA_SILENT'];
    delete process.env['CLAUDE_QUOTA_SILENT'];
    intercept = interceptStderr();
  });

  afterEach(() => {
    intercept.restore();
    if (prevSilent === undefined) delete process.env['CLAUDE_QUOTA_SILENT'];
    else process.env['CLAUDE_QUOTA_SILENT'] = prevSilent;
  });

  test('emits a single newline-terminated line to stderr', () => {
    warn('something happened');
    assert.equal(intercept.captured.length, 1);
    assert.equal(intercept.captured[0], '[claude-quota] something happened\n');
  });

  test('appends key=value context in insertion order', () => {
    warn('cache rejected', { path: '/tmp/x', reason: 'permissive-mode' });
    assert.equal(
      intercept.captured[0],
      '[claude-quota] cache rejected path=/tmp/x reason=permissive-mode\n',
    );
  });

  test('silenced by CLAUDE_QUOTA_SILENT=1', () => {
    process.env['CLAUDE_QUOTA_SILENT'] = '1';
    warn('should not appear');
    assert.deepEqual(intercept.captured, []);
  });

  test('non-"1" values of CLAUDE_QUOTA_SILENT do not silence', () => {
    process.env['CLAUDE_QUOTA_SILENT'] = '0';
    warn('still emits');
    assert.equal(intercept.captured.length, 1);
  });

  test('never throws on stderr write failure', () => {
    intercept.restore();
    // Throw from stderr.write to confirm warn swallows it rather than
    // crashing the plugin during a render.
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((): boolean => { throw new Error('broken pipe'); }) as typeof process.stderr.write;
    try {
      assert.doesNotThrow(() => warn('resilient'));
    } finally {
      process.stderr.write = original;
    }
  });
});
