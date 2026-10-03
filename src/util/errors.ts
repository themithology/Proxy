/** Application-level error that maps cleanly onto an HTTP status. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = 'internal_error',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(msg: string, details?: unknown) {
    return new AppError(400, msg, 'bad_request', details);
  }
  static unauthorized(msg = 'Missing or invalid API key') {
    return new AppError(401, msg, 'unauthorized');
  }
  static forbidden(msg = 'Forbidden') {
    return new AppError(403, msg, 'forbidden');
  }
  static notFound(msg = 'Not found') {
    return new AppError(404, msg, 'not_found');
  }
  static upstream(msg = 'Upstream source failed', details?: unknown) {
    return new AppError(502, msg, 'upstream_error', details);
  }
  static timeout(msg = 'Upstream source timed out') {
    return new AppError(504, msg, 'upstream_timeout');
  }
}

/** Wrap a thrown value into an AppError, preserving status when present. */
export function toAppError(err: unknown, fallbackMsg = 'Internal error'): AppError {
  if (err instanceof AppError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new AppError(500, `${fallbackMsg}: ${msg}`);
}
