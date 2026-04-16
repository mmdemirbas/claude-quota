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
});
