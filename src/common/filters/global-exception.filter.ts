import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import * as Sentry from '@sentry/nestjs';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    // message: string or string[] (validation errors)
    let message: string | string[] = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else {
        const body = exceptionResponse as Record<string, unknown>;
        // Preserve array of validation messages in full — callers get all failures.
        message = (body.message as string | string[]) ?? exception.message;
      }
    } else if (exception instanceof Error) {
      // Never expose raw database errors (SQL statements, constraint names, etc.)
      // to the client — replace them with a safe generic message in all environments.
      const isDbError =
        (exception as any).code?.startsWith?.('23') || // Postgres integrity constraints
        (exception as any).code?.startsWith?.('42') || // Postgres syntax / missing column
        /^(insert|update|delete|select)\s/i.test(exception.message) ||
        exception.message.toLowerCase().includes('duplicate key') ||
        exception.message.toLowerCase().includes('violates') ||
        exception.message.toLowerCase().includes('relation') ||
        exception.message.toLowerCase().includes('column') ||
        exception.message.toLowerCase().includes('syntax error');

      message = isDbError
        ? 'An unexpected error occurred. Please try again.'
        : exception.message;
    }

    // Forward 5xx errors to Sentry — 4xx are client errors, not bugs.
    if (status >= 500) {
      Sentry.withScope((scope) => {
        scope.setTag('source', 'global_exception_filter');
        scope.setContext('request', {
          method: request.method,
          url: request.url,
          body: request.body,
        });
        Sentry.captureException(exception);
      });
    }

    this.logger.error(
      `${request.method} ${request.url} - ${status}`,
      exception instanceof Error ? exception.stack : JSON.stringify(exception),
    );

    const isProduction = process.env.NODE_ENV === 'production';

    response.status(status).json({
      statusCode: status,
      // Always return the full messages array so clients see all validation failures.
      message: Array.isArray(message) ? message : [message],
      // Stack traces only in non-production environments.
      ...(!isProduction && exception instanceof Error && {
        debug: {
          name: exception.name,
          stack: exception.stack?.split('\n').slice(0, 8),
        },
      }),
    });
  }
}
