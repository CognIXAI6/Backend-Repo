import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

const CORRELATION_ID_HEADER = 'x-correlation-id';

export interface RequestWithCorrelation extends Request {
  correlationId?: string;
  _startedAt?: number;
}

/**
 * Stamps every request with a correlation ID (reusing an incoming one if the
 * caller already sent one) so a single request can be traced across this
 * app's own logs and Sentry. Also records a start timestamp so the global
 * exception filter can report request duration on 5xx.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const request = req as RequestWithCorrelation;
  const incoming = req.headers[CORRELATION_ID_HEADER];
  request.correlationId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
  request._startedAt = Date.now();
  res.setHeader(CORRELATION_ID_HEADER, request.correlationId);
  next();
}
