'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function testStaticDeploymentWiring() {
  const dockerfile = read('Dockerfile');
  assert(dockerfile.includes('npm ci --omit=dev'));
  assert(dockerfile.includes('CMD ["node", "scripts/player-server.mjs"]'));
  assert(!dockerfile.includes('CMD ["node", "src/server.js"]'), 'production image must not be API-only');
  assert(dockerfile.includes('MKV_HLS_ENABLED=true'));
  assert(dockerfile.includes('MKV_HLS_NODE_HOST=true'));
  assert(dockerfile.includes('MKV_HLS_DIR=/data/hls'));
  assert(dockerfile.includes('USER node'));

  const compose = read('docker-compose.yml');
  assert(compose.includes('lol-embed:'));
  assert(compose.includes('build: .'));
  assert(compose.includes('hls-data:/data/hls'));
  assert(compose.includes('caddy:2-alpine'));
  assert(compose.includes('condition: service_healthy'));
  assert(compose.includes('./deploy/Caddyfile:/etc/caddy/Caddyfile:ro'));
  assert(compose.includes('caddy-data:/data'));
  assert(compose.includes('"80:80"') && compose.includes('"443:443"'));
  assert(compose.includes('http://127.0.0.1:3000/api/health'));

  const caddy = read('deploy/Caddyfile');
  assert(caddy.includes('{$DOMAIN}'));
  assert(caddy.includes('reverse_proxy lol-embed:3000'));
  assert(caddy.includes('flush_interval -1'));

  const ecosystem = require(path.join(root, 'ecosystem.config.js'));
  assert.strictEqual(ecosystem.apps.length, 1);
  assert.strictEqual(ecosystem.apps[0].script, 'scripts/player-server.mjs');
  assert.strictEqual(ecosystem.apps[0].instances, 1);
  assert.strictEqual(ecosystem.apps[0].exec_mode, 'fork');

  assert(read('scripts/dev-worker.mjs').includes("import './player-server.mjs';"));
  assert(read('scripts/player-server.mjs').includes('createMkvHlsHandler'));
  assert(read('package.json').includes('"start:player": "node scripts/player-server.mjs"'));
  assert(read('.dockerignore').includes('node_modules'));
  assert(read('.dockerignore').includes('.env'));
  assert(fs.statSync(path.join(root, 'deploy/vps.sh')).mode & 0o111, 'VPS installer must be executable');
  assert(fs.statSync(path.join(root, 'deploy/quick-tunnel.sh')).mode & 0o111, 'Quick Tunnel launcher must be executable');
  const quickTunnel = read('deploy/quick-tunnel.sh');
  assert(quickTunnel.includes('cloudflared-linux-$CLOUDFLARED_ARCH'));
  assert(quickTunnel.includes('trycloudflare'));
  assert(quickTunnel.includes('set_env PUBLIC_BASE_URL "$TUNNEL_URL"'));
  assert(quickTunnel.indexOf('set_env PUBLIC_BASE_URL "$TUNNEL_URL"') < quickTunnel.indexOf('node scripts/player-server.mjs'), 'public origin must be configured before player startup');
  assert(read('README.md').includes('sudo bash deploy/vps.sh embed.example.com'));

  for (const script of ['deploy/vps.sh', 'deploy/env.sh', 'deploy/quick-tunnel.sh']) {
    const syntax = spawnSync('bash', ['-n', path.join(root, script)], { encoding: 'utf8' });
    assert.strictEqual(syntax.status, 0, syntax.stderr);
  }
}

function testEnvironmentPreservation() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-deploy-env-test-'));
  try {
    fs.writeFileSync(path.join(tempDir, '.env'), [
      'ADMIN_SECRET=existing-admin-secret',
      'PROXY_SECRET=change-this-to-a-random-proxy-secret',
      'NEW_SECRET=admin123',
      'TMDB_API_KEY=existing-tmdb-key',
      'FEBBOX_EMAIL=owner@example.test',
      'GOLDMINE_API_BASE=https://goldmine.example.test',
      'MKV_HLS_MAX_SESSIONS=7',
      ''
    ].join('\n'));
    const helper = path.join(root, 'deploy/env.sh');
    const script = `
      set -Eeuo pipefail
      source ${JSON.stringify(helper)}
      ensure_secret ADMIN_SECRET
      ensure_secret PROXY_SECRET
      ensure_secret NEW_SECRET
      test "$(get_env ADMIN_SECRET)" = existing-admin-secret
      test "$(get_env TMDB_API_KEY)" = existing-tmdb-key
      test "$(get_env FEBBOX_EMAIL)" = owner@example.test
      test "$(get_env GOLDMINE_API_BASE)" = https://goldmine.example.test
      test "$(get_env MKV_HLS_MAX_SESSIONS)" = 7
      [[ "$(get_env PROXY_SECRET)" =~ ^[0-9a-f]{64}$ ]]
      [[ "$(get_env NEW_SECRET)" =~ ^[0-9a-f]{64}$ ]]
      first_proxy="$(get_env PROXY_SECRET)"
      first_new="$(get_env NEW_SECRET)"
      ensure_secret PROXY_SECRET
      ensure_secret NEW_SECRET
      test "$(get_env PROXY_SECRET)" = "$first_proxy"
      test "$(get_env NEW_SECRET)" = "$first_new"
      set_env PUBLIC_BASE_URL 'https://embed.example.test'
      test "$(get_env PUBLIC_BASE_URL)" = https://embed.example.test
    `;
    const result = spawnSync('bash', ['-c', script], { cwd: tempDir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function testProductionEntrypoint() {
  const port = await unusedPort();
  const hlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-deploy-server-test-'));
  let child;
  try {
    child = spawn(process.execPath, ['scripts/player-server.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PLAYER_PORT: String(port),
        HOST: '127.0.0.1',
        PUBLIC_BASE_URL: '',
        MKV_HLS_ENABLED: 'true',
        MKV_HLS_NODE_HOST: 'true',
        MKV_HLS_DIR: hlsDir,
        ADS_ENABLED: 'false',
        ADMIN_SECRET: 'deployment-test-only',
        PROXY_SECRET: 'deployment-test-only'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });

    let health;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`player exited during startup:\n${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch (_) {
        // The listener may not be ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.strictEqual(health && health.ok, true, `player did not become healthy:\n${output}`);

    const embedResponse = await fetch(`http://127.0.0.1:${port}/embed/movie/693134`);
    const embed = await embedResponse.text();
    assert.strictEqual(embedResponse.status, 200);
    assert(embed.includes('<video id="video-element"'));
    assert(embed.includes('mkvHlsEnabled":true'), 'full Node player must advertise its mounted converter');

    const assetResponse = await fetch(`http://127.0.0.1:${port}/js/embed.js`);
    const asset = await assetResponse.text();
    assert.strictEqual(assetResponse.status, 200);
    assert(asset.includes('generatedStartTime'), 'production server must serve the current player asset');
  } finally {
    if (child && child.exitCode === null) {
      await new Promise((resolve) => {
        const forceKill = setTimeout(() => child.kill('SIGKILL'), 6000);
        forceKill.unref();
        child.once('exit', () => {
          clearTimeout(forceKill);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    fs.rmSync(hlsDir, { recursive: true, force: true });
  }
}

(async () => {
  testStaticDeploymentWiring();
  testEnvironmentPreservation();
  await testProductionEntrypoint();
  console.log('  ✔ Full-player Docker/Caddy wiring, secret preservation and production entrypoint passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
