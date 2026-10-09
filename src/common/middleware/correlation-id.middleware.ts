import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/nestjs';

const CORRELATION_ID_HEADER = 'x-correlation-id';

export interface RequestWithCorrelation extends Request {
  correlationId?: string;
  _startedAt?: number;
}

const logger = new Logger('SlowRequest');

// A request taking this long is worth a WARN in the logs even though it
// eventually completed — e.g. PM2's logs/out.log on the production box.
const SLOW_REQUEST_WARN_MS = 3_000;
// A request taking this long (or a client giving up before any response was
// sent at all — the "server is taking too long to respond" toast on the
// frontend) is worth a searchable Sentry event, not just a log line, since
// error_logs/Pino aren't checked proactively the way a Sentry alert is.
const SLOW_REQUEST_SENTRY_MS = 10_000;

/**
 * Stamps every request with a correlation ID (reusing an incoming one if the
 * caller already sent one) so a single request can be traced across this
 * app's own logs and Sentry. Also records a start timestamp so the global
 * exception filter can report request duration on 5xx, and — separately —
 * so this middleware itself can flag slow or client-abandoned requests that
 * never throw at all (a request that just takes too long isn't an
 * exception, so GlobalExceptionFilter never sees it; this is the only place
 * that watches every request's full lifetime regardless of outcome).
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const request = req as RequestWithCorrelation;
  const incoming = req.headers[CORRELATION_ID_HEADER];
  request.correlationId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
  request._startedAt = Date.now();
  res.setHeader(CORRELATION_ID_HEADER, request.correlationId);

  let settled = false;
  const report = (outcome: 'completed' | 'client_aborted') => {
    if (settled) return;
    settled = true;

    const durationMs = Date.now() - (request._startedAt ?? Date.now());
    if (durationMs < SLOW_REQUEST_WARN_MS) return;

    const label = `${req.method} ${req.originalUrl} — ${durationMs}ms (${outcome}, status=${res.statusCode})`;
    logger.warn(`[${request.correlationId}] ${label}`);

    if (durationMs >= SLOW_REQUEST_SENTRY_MS || outcome === 'client_aborted') {
      Sentry.withScope((scope) => {
        scope.setTag('source', 'slow_request_middleware');
        scope.setTag('correlation_id', request.correlationId ?? 'unknown');
        scope.setTag('outcome', outcome);
        scope.setContext('request', { method: req.method, url: req.originalUrl, durationMs, statusCode: res.statusCode });
        scope.setLevel('warning');
        Sentry.captureMessage(`Slow request: ${label}`);
      });
    }
  };

  // 'finish' = response fully sent, however long it took.
  res.on('finish', () => report('completed'));
  // 'close' fires after 'finish' too (normal socket teardown) — only treat
  // it as a genuine client-abandoned request when no response was ever sent.
  res.on('close', () => {
    if (!res.writableEnded) report('client_aborted');
  });

  next();
}
