import { config } from './config.js';
import pino from 'pino';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'proxy' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers["x-api-key"]',
      'req.headers.authorization',
      '*.url',
      '*.token',
      '*.apiKey',
    ],
    censor: '[redacted]',
  },
  transport: config.isProd || config.NODE_ENV === 'test'
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          singleLine: false,
        },
      },
});

export type Logger = typeof logger;

/** Child logger bound to a subsystem (e.g. "provider:stremio"). */
export const logFor = (subsystem: string) => logger.child({ sub: subsystem });
