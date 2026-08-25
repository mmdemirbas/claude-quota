import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { terminalDims } from '../src/terminal.js';

describe('terminalDims', () => {
  test('returns default 120×3 when no source provides dims', () => {
    // Pass null stdin; env vars COLUMNS/LINES may or may not be set in CI,
    // so we only assert the caps/defaults hold — not specific env values.
    // We verify the shape and validity of the result.
    const dims = terminalDims(null);
    assert.ok(dims.columns > 0, 'columns must be positive');
    assert.ok(dims.rows > 0 && dims.rows <= 3, 'rows must be 1–3');
  });

  test('uses columns from stdin when provided', () => {
    const dims = terminalDims({ columns: 80 });
    assert.equal(dims.columns, 80);
  });

  test('uses rows from stdin when provided', () => {
    const dims = terminalDims({ rows: 2 });
    assert.equal(dims.rows, 2);
  });

  test('caps rows from stdin at 3', () => {
    const dims = terminalDims({ rows: 50 });
    assert.equal(dims.rows, 3);
  });

  test('ignores non-positive column values from stdin', () => {
    const dims = terminalDims({ columns: 0 });
    // Falls back to env / stderr / default — must still be positive
    assert.ok(dims.columns > 0);
  });

  test('ignores non-positive row values from stdin', () => {
    const dims = terminalDims({ rows: 0 });
    assert.ok(dims.rows > 0 && dims.rows <= 3);
  });

  test('floors fractional values', () => {
    const dims = terminalDims({ columns: 99.9, rows: 2.7 });
    assert.equal(dims.columns, 99);
    assert.equal(dims.rows, 2);
  });

  // Hostile COLUMNS/LINES injection: a caller (or a malicious shell env)
  // can hand us MAX_SAFE_INTEGER, which the renderer would then try to
  // allocate a string for. MAX_DIM caps the accepted range; larger values
  // fall through to the next source (stderr TTY, env var, default).
  test('ignores absurdly large column values from stdin', () => {
    const dims = terminalDims({ columns: 999_999_999 });
    assert.ok(dims.columns < 100_000,
      'columns must fall back to a sane value for 999_999_999');
  });

  test('ignores Number.MAX_SAFE_INTEGER from stdin', () => {
    const dims = terminalDims({ columns: Number.MAX_SAFE_INTEGER, rows: Number.MAX_SAFE_INTEGER });
    assert.ok(dims.columns < 100_000);
    assert.ok(dims.rows <= 3);
  });

  test('accepts values up to the cap', () => {
    const dims = terminalDims({ columns: 10_000 });
    assert.equal(dims.columns, 10_000);
  });

  test('rejects values just above the cap', () => {
    const dims = terminalDims({ columns: 10_001 });
    assert.ok(dims.columns < 10_001,
      'columns > 10000 from stdin must not be trusted');
  });

  describe('COLUMNS from the environment', () => {
    /**
     * These only bind when no earlier source answers, so stderr must not be a
     * TTY. It is a pipe under the test runner, which is what makes the env var
     * the deciding source here.
     */
    function withColumns<T>(value: string, fn: () => T): T {
      const saved = process.env['COLUMNS'];
      process.env['COLUMNS'] = value;
      try {
        return fn();
      } finally {
        if (saved === undefined) delete process.env['COLUMNS'];
        else process.env['COLUMNS'] = saved;
      }
    }

    test('a plain integer is used', () => {
      assert.equal(withColumns('80', () => terminalDims(null).columns), 80);
    });

    test('surrounding whitespace is tolerated — a shell may leave a newline', () => {
      assert.equal(withColumns('  90 \n', () => terminalDims(null).columns), 90);
    });

    test('scientific notation is refused rather than half-read', () => {
      // parseInt('1e5', 10) stops at the 'e' and returns 1, so the statusline
      // rendered into a single column: every field truncated away, and no
      // error anywhere to say why. A value that is not a run of digits is not
      // a dimension.
      assert.equal(withColumns('1e5', () => terminalDims(null).columns), 120);
    });

    test('a number with trailing junk is refused, not silently accepted', () => {
      assert.equal(withColumns('80abc', () => terminalDims(null).columns), 120);
    });

    test('hex, words and empty all fall through to the default', () => {
      for (const v of ['0x50', 'wide', '', '-80', '12.5']) {
        assert.equal(withColumns(v, () => terminalDims(null).columns), 120,
          `COLUMNS=${JSON.stringify(v)} must not be read as a width`);
      }
    });
  });
});
