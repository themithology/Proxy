import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs in its own process: `config` is a module-level singleton. */
const tmp = mkdtempSync(join(tmpdir(), 'proxy-auth-'));
const configPath = join(tmp, 'providers.json');

process.env.NODE_ENV = 'test';
process.env.PUBLIC_URL = 'http://proxy.test';
process.env.PROXY_SECRET = 'auth-test-secret';
process.env.API_KEY = 'secret-key-abc123';
process.env.CACHE_DRIVER = 'memory';
process.env.CACHE_DIR = tmp;
process.env.PROVIDERS_CONFIG = configPath;
process.env.TMDB_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_MAX = '10000';

writeFileSync(configPath, JSON.stringify({ version: 1, providers: [] }));

const { buildServer } = await import('../../src/http/server.js');
const { registry } = await import('../../src/providers/registry.js');
const { cache } = await import('../../src/store/cache.js');

let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  await cache.init();
  await registry.load(configPath);
  app = await buildServer();
});

after(async () => {
  try { await app?.close(); } catch { /* ignore */ }
  try { await cache.close(); } catch { /* ignore */ }
});

test('public endpoints stay open without a key', async () => {
  for (const url of ['/api/health', '/openapi.json', '/api/docs']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `${url} should be public`);
  }
});

test('protected API routes reject a missing key', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/providers' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'unauthorized');
});

test('protected API routes reject a wrong key', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/providers',
    headers: { 'x-api-key': 'not-the-key' },
  });
  assert.equal(res.statusCode, 401);
});

test('x-api-key header is accepted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/providers',
    headers: { 'x-api-key': 'secret-key-abc123' },
  });
  assert.equal(res.statusCode, 200);
});

test('Authorization: Bearer is accepted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/providers',
    headers: { authorization: 'Bearer secret-key-abc123' },
  });
  assert.equal(res.statusCode, 200);
});

test('?api_key= query parameter is accepted', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/providers?api_key=secret-key-abc123' });
  assert.equal(res.statusCode, 200);
});

test('proxy routes require a key when auth is on', async () => {
  const res = await app.inject({ method: 'GET', url: '/proxy/segment?token=garbage' });
  assert.equal(res.statusCode, 401);
});

test('the static player page stays reachable', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type']!, /text\/html/);
  assert.ok(res.body.includes('Proxy'));
});

test('player engines are served locally', async () => {
  const res = await app.inject({ method: 'GET', url: '/vendor/hls.min.js' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type']!, /javascript/);
  assert.ok(res.body.length > 50_000, 'hls.js bundle should be present');
});
