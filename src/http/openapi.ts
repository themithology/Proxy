import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * OpenAPI 3.1 description of the public surface, plus a small docs page.
 * Kept as data (not generated) so it stays readable and always in sync.
 */

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Proxy — Multi-Provider Streaming API',
    version: '1.0.0',
    description:
      'Aggregates playable streams from multiple providers, then serves them ' +
      'through a rewriting proxy so any browser or player can play them: HLS and ' +
      'DASH manifests are rewritten, segments are proxied with Range support, and ' +
      'subtitles are transcoded to WebVTT.\n\n' +
      'Providers are plugins. The built-in kinds are `stremio`, `archive`, ' +
      '`youtube`, `direct` and `webextract`; add your own in config/providers.json.',
    license: { name: 'MIT' },
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Streams', description: 'Resolve playable streams' },
    { name: 'Metadata', description: 'Search and title metadata' },
    { name: 'Proxy', description: 'Byte-serving endpoints (signed tokens)' },
    { name: 'Operations', description: 'Health, providers, cache' },
  ],
  security: config.hasApiKey ? [{ ApiKeyAuth: [] }] : [],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description:
          'Also accepts `Authorization: Bearer <key>` or `?api_key=<key>`. ' +
          'Only enforced when the API_KEY env var is set.',
      },
    },
    schemas: {
      Playback: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['hls', 'dash', 'mp4', 'embed', 'torrent', 'unknown'] },
          url: { type: 'string', description: 'Proxied URL on this origin — always playable' },
          direct: { type: 'string', description: 'Raw upstream URL (only when expose=direct)' },
          embed: { type: 'string' },
          via: { type: 'string', enum: ['direct', 'extracted', 'sniffed'] },
          infoHash: { type: 'string' },
        },
        required: ['type', 'url'],
      },
      Subtitle: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          lang: { type: 'string', example: 'hi' },
          label: { type: 'string', example: 'Hindi' },
          format: { type: 'string', example: 'vtt' },
        },
      },
      ResolvedStream: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          provider: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' } },
          },
          name: { type: 'string' },
          quality: { type: 'string', example: '1080p' },
          height: { type: 'integer', example: 1080 },
          language: { type: 'string', example: 'hi' },
          kind: { type: 'string' },
          sizeBytes: { type: 'integer' },
          seeders: { type: 'integer' },
          subtitles: { type: 'array', items: { $ref: '#/components/schemas/Subtitle' } },
          playback: { $ref: '#/components/schemas/Playback' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: false },
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/api/streams/{type}/{id}': {
      get: {
        tags: ['Streams'],
        summary: 'Resolve playable streams for a title',
        description:
          'Fans out to every matching provider, ranks and de-duplicates the ' +
          'results, and returns proxied playback URLs.',
        parameters: [
          {
            name: 'type',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['movie', 'series', 'anime', 'tv'] },
          },
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'IMDB id (tt0111161), TMDB id (278 or tmdb:278), or a prefixed id',
            example: 'tt0111161',
          },
          { name: 'season', in: 'query', schema: { type: 'integer' } },
          { name: 'episode', in: 'query', schema: { type: 'integer' } },
          {
            name: 'lang',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated preferred audio languages, in priority order',
            example: 'hi,en',
          },
          {
            name: 'only',
            in: 'query',
            schema: { type: 'string' },
            description: 'Hard filter to these languages',
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
          { name: 'minHeight', in: 'query', schema: { type: 'integer' } },
          {
            name: 'maxHeight',
            in: 'query',
            schema: { type: 'integer' },
            description: 'Useful for capping bandwidth on mobile',
          },
          {
            name: 'playable',
            in: 'query',
            schema: { type: 'string', enum: ['true', 'false'] },
            description: 'Drop embeds/torrents and keep only directly playable streams',
          },
          {
            name: 'expose',
            in: 'query',
            schema: { type: 'string', enum: ['direct'] },
            description: 'Include raw upstream URLs in the response',
          },
          { name: 'title', in: 'query', schema: { type: 'string' }, description: 'Override title (when TMDB is off)' },
          { name: 'year', in: 'query', schema: { type: 'integer' } },
          {
            name: 'diagnostics',
            in: 'query',
            schema: { type: 'string', enum: ['true', 'false'] },
            description: 'Include per-provider timings and error messages',
          },
        ],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    count: { type: 'integer' },
                    streams: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ResolvedStream' },
                    },
                  },
                },
              },
            },
          },
          400: { $ref: '#/components/responses/Error' },
          401: { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/api/resolve': {
      post: {
        tags: ['Streams'],
        summary: 'Resolve a single URL into a playable stream',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string' },
                  headers: { type: 'object', additionalProperties: { type: 'string' } },
                  kind: { type: 'string', enum: ['hls', 'dash', 'mp4', 'embed', 'unknown'] },
                  title: { type: 'string' },
                  language: { type: 'string' },
                  quality: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'OK' }, 400: { $ref: '#/components/responses/Error' } },
      },
    },
    '/api/search': {
      get: {
        tags: ['Metadata'],
        summary: 'Search for titles',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          {
            name: 'type',
            in: 'query',
            schema: { type: 'string', enum: ['movie', 'series', 'anime'] },
          },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        ],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/meta/{type}/{id}': {
      get: {
        tags: ['Metadata'],
        summary: 'Full metadata for one title',
        parameters: [
          { name: 'type', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/providers': {
      get: {
        tags: ['Operations'],
        summary: 'List providers and their health',
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/health': {
      get: {
        tags: ['Operations'],
        summary: 'Service health',
        responses: { 200: { description: 'OK' } },
      },
    },
    '/proxy/manifest': {
      get: {
        tags: ['Proxy'],
        summary: 'Rewritten HLS/DASH manifest',
        parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, 401: { $ref: '#/components/responses/Error' } },
      },
    },
    '/proxy/segment': {
      get: {
        tags: ['Proxy'],
        summary: 'Proxied segment / AES key / init segment (Range supported)',
        parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, 206: { description: 'Partial content' } },
      },
    },
    '/proxy/subtitle': {
      get: {
        tags: ['Proxy'],
        summary: 'Subtitle transcoded to WebVTT',
        parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/proxy/sign': {
      post: {
        tags: ['Proxy'],
        summary: 'Mint a signed proxy URL',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string' },
                  headers: { type: 'object', additionalProperties: { type: 'string' } },
                  kind: { type: 'string', enum: ['manifest', 'segment', 'subtitle', 'key', 'other'] },
                  ttlSeconds: { type: 'integer', default: 21600 },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'OK' } },
      },
    },
  },
  components_responses_placeholder: undefined as never,
  responses: {
    Error: {
      description: 'Error',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } },
      },
    },
  },
} as Record<string, unknown>;

// Hooks referenced as `#/components/responses/Error` need to exist under
// `components.responses` for strict validators; keep both shapes valid.
(spec.components as Record<string, unknown>).responses = {
  Error: (spec as { responses: Record<string, unknown> }).responses.Error,
};
delete (spec as Record<string, unknown>).components_responses_placeholder;

export async function openapiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/openapi.json', async (_req, reply) => {
    return reply.type('application/json').send(spec);
  });

  app.get('/api/docs', async (_req, reply) => {
    return reply.type('text/html').send(docsPage());
  });
}

function docsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Proxy API · Docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
<style>body{margin:0;background:#0b0d12}</style>
</head>
<body>
<div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  window.onload = () => {
    SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger', deepLinking: true });
  };
</script>
</body>
</html>`;
}
