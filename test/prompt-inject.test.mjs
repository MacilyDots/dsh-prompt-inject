import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

test('normalizePath matches Windows backslash/forward-slash and case-insensitively', () => {
  let provider;
  const ctx = {
    systemPrompt: {
      variable(name, fn) {
        assert.equal(name, 'inject');
        provider = fn;
      },
    },
  };
  apply(ctx, { text: 'HELLO', cwds: ['X:\\work\\proj\\'] });

  const matchLower = provider({ agent: { session: { header: { cwd: 'x:/work/proj' } } } });
  assert.equal(matchLower, 'HELLO');

  const matchTrail = provider({ agent: { session: { header: { cwd: 'X:/work/proj///' } } } });
  assert.equal(matchTrail, 'HELLO');

  const miss = provider({ agent: { session: { header: { cwd: 'X:/other' } } } });
  assert.equal(miss, '');
});

test('enabled=false returns empty string', () => {
  let provider;
  apply({ systemPrompt: { variable(_n, fn) { provider = fn; } } }, { enabled: false, text: 'HELLO' });
  assert.equal(provider({}), '');
});
