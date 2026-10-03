import 'dotenv/config';
import { config } from './config.js';
import { logger } from './logger.js';
import { cache } from './cache/index.js';
import { registry } from './providers/registry.js';
import { startServer } from './http/server.js';

/**
 * Proxy — boot sequence.
 *
 *   1. cache      (memory | sqlite | redis | none)
 *   2. providers  (config/providers.json)
 *   3. http       (Fastify)
 *
 * A failure in (2) is non-fatal: the API starts with whatever providers did
 * initialise, so a single misconfigured source never takes the service down.
 */
async function main(): Promise<void> {
  logger.info(
    {
      node: process.version,
      env: config.NODE_ENV,
      publicOrigin: config.publicOrigin,
    },
    'starting Proxy',
  );

  await cache.init();

  try {
    await registry.load();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'provider registry failed to load — continuing without providers',
    );
  }

  await startServer();
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.stack : String(err) }, 'fatal startup error');
  process.exit(1);
});
