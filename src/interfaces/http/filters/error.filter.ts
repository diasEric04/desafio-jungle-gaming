import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TransientInfrastructureError } from '@/application/errors';
import { DomainError } from '@/domain/errors';
import type { Container } from '@/infrastructure/container';
import { CONTAINER } from '../tokens';
import { RequestValidationError } from '../validation';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** true: the SAME request may be re-sent unchanged (every write path is idempotent). */
    retryable: boolean;
    details?: ReadonlyArray<{ path: string; message: string }>;
  };
  correlationId: string;
}

/**
 * One mapping for every endpoint, so a provider can decide what to do from the status alone:
 *   400 invalid payload             -> fix it, do not resend as is
 *   404 unknown wallet/transaction  -> do not resend
 *   409 conflict (idempotency key reused with another payload, duplicate wallet)
 *   422 business rejection          -> body of the transaction result (not an error envelope)
 *   202 accepted, pending reference -> keep waiting / poll
 *   503 transient infrastructure    -> resend the same request later (Retry-After)
 *   500 unexpected                  -> safe to resend the same request
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const correlationId = String(request.headers['x-correlation-id'] ?? '');

    const { status, error } = this.translate(exception);
    if (status >= 500) {
      this.container.logger.error('request failed', {
        correlationId,
        method: request.method,
        path: request.path,
        status,
        error:
          exception instanceof Error
            ? `${exception.name}: ${exception.message}`
            : String(exception),
      });
    }
    if (status === 503) response.setHeader('Retry-After', '1');
    response.status(status).json({ error, correlationId } satisfies ErrorBody);
  }

  private translate(exception: unknown): { status: number; error: ErrorBody['error'] } {
    if (exception instanceof RequestValidationError) {
      return {
        status: 400,
        error: {
          code: 'VALIDATION_ERROR',
          message: exception.message,
          retryable: false,
          details: exception.details,
        },
      };
    }
    if (exception instanceof DomainError) {
      const status = { VALIDATION: 400, CONFLICT: 409, NOT_FOUND: 404, INVARIANT: 500 }[
        exception.category
      ];
      return {
        status,
        error: {
          code: exception.code,
          message: status === 500 ? 'Internal error' : exception.message,
          retryable: status === 500,
        },
      };
    }
    if (exception instanceof TransientInfrastructureError) {
      return {
        status: 503,
        error: {
          code: 'INFRASTRUCTURE_UNAVAILABLE',
          message: 'Temporarily unavailable, retry the same request',
          retryable: true,
        },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        error: { code: `HTTP_${status}`, message: exception.message, retryable: false },
      };
    }
    return {
      status: 500,
      error: { code: 'INTERNAL_ERROR', message: 'Internal error', retryable: true },
    };
  }
}
