import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originFromRequest, currentOrigin, enterOrigin } from '../../src/util/origin.js';
import { config } from '../../src/config.js';

test('originFromRequest builds an origin from Host', () => {
  assert.equal(
    originFromRequest({ host: 'cdn.example.com' }),
    'http://cdn.example.com',
  );
});

test('originFromRequest respects X-Forwarded-Proto when trusted', () => {
  if (!config.TRUST_PROXY) return; // depends on env; default is on
  assert.equal(
    originFromRequest({
      host: 'internal:3000',
      'x-forwarded-host': 'stream.example.com',
      'x-forwarded-proto': 'https',
    }),
    'https://stream.example.com',
  );
});

test('originFromRequest takes the first value of a multi-valued header', () => {
  assert.equal(
    originFromRequest({ host: ['a.example.com', 'b.example.com'] }),
    'http://a.example.com',
  );
});

test('originFromRequest returns null without a host', () => {
  assert.equal(originFromRequest({}), null);
});

test('originFromRequest strips a trailing slash', () => {
  assert.equal(originFromRequest({ host: 'x.example.com/' }), 'http://x.example.com');
});

test('enterOrigin scopes the derived origin to the current async context', async () => {
  enterOrigin('https://derived.example.com');
  assert.equal(currentOrigin(), 'https://derived.example.com');

  // A nested async boundary keeps the value…
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(currentOrigin(), 'https://derived.example.com');
});
