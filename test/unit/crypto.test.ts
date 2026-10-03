import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, stableHash } from '../../src/util/crypto.js';

test('sign and verify round-trips', () => {
  const payload = {
    u: 'https://cdn.example.com/hls/1080/index.m3u8',
    h: { referer: 'https://example.com/' },
    e: Date.now() + 60_000,
    k: 'manifest' as const,
  };
  const token = signToken(payload);
  const back = verifyToken(token);

  assert.ok(back);
  assert.equal(back!.u, payload.u);
  assert.deepEqual(back!.h, payload.h);
  assert.equal(back!.k, 'manifest');
});

test('a tampered payload is rejected', () => {
  const token = signToken({ u: 'https://a.test/x.m3u8', e: Date.now() + 60_000 });
  const [body, sig] = token.split('.');

  // Flip the payload, keep the signature.
  const forged = `${Buffer.from(
    JSON.stringify({ u: 'https://evil.test/y.m3u8', e: Date.now() + 60_000 }),
  ).toString('base64url')}.${sig}`;

  assert.equal(verifyToken(forged), null);
});

test('a tampered signature is rejected', () => {
  const token = signToken({ u: 'https://a.test/x.m3u8', e: Date.now() + 60_000 });
  const [body, sig] = token.split('.');
  const badSig = sig!.slice(0, -2) + (sig!.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(verifyToken(`${body}.${badSig}`), null);
});

test('an expired token is rejected', () => {
  const token = signToken({ u: 'https://a.test/x.m3u8', e: Date.now() - 1 });
  assert.equal(verifyToken(token), null);
});

test('garbage input never throws', () => {
  for (const bad of ['', 'x', 'a.b', '.', '....', '%%%', 'eyJ9.abc']) {
    assert.equal(verifyToken(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('stableHash is deterministic and stable in length', () => {
  const a = stableHash('hello world');
  const b = stableHash('hello world');
  const c = stableHash('hello world!');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.length > 0 && a.length <= 32);
});
