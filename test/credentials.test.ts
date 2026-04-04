import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getPlanName } from '../src/credentials.js';

describe('getPlanName', () => {
  test('recognises Max plan', () => {
    assert.equal(getPlanName('claude_max_20'), 'Max');
    assert.equal(getPlanName('MAX'), 'Max');
  });

  test('recognises Pro plan', () => {
    assert.equal(getPlanName('claude_pro'), 'Pro');
    assert.equal(getPlanName('PRO'), 'Pro');
  });

  test('recognises Team plan', () => {
    assert.equal(getPlanName('claude_team'), 'Team');
  });

  test('returns null for API users', () => {
    assert.equal(getPlanName('api_user'), null);
    assert.equal(getPlanName(''), null);
  });

  test('capitalises unknown plan types', () => {
    // Unknown subscription types are returned title-cased rather than rejected,
    // so new plan tiers surface in the UI before the code is updated.
    assert.equal(getPlanName('enterprise'), 'Enterprise');
  });
});
