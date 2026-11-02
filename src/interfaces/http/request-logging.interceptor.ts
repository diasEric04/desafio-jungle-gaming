import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import type { Container } from '@/infrastructure/container';
import { CONTAINER } from './tokens';

/** One access-log line per request with the correlation id (no bodies, no amounts). */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const started = performance.now();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    return next.handle().pipe(
      tap({
        next: () => this.log(request, response.statusCode, started),
      }),
    );
  }

  private log(request: Request, status: number, started: number): void {
    this.container.logger.info('http request', {
      correlationId: String(request.headers['x-correlation-id'] ?? ''),
      method: request.method,
      path: request.route?.path ?? request.path,
      status,
      durationMs: Math.round(performance.now() - started),
    });
  }
}
