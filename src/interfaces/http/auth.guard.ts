import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Container } from '@/infrastructure/container';
import { IS_PUBLIC } from './public.decorator';
import { CONTAINER } from './tokens';

/**
 * Authentication/authorization extension point. With the default `AllowAllProviderIdentity` it lets
 * every request through; plugging a real IdP adapter (see ARCHITECTURE.md) only requires replacing
 * that port, not touching controllers or use cases. Health and metrics are always public.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONTAINER) private readonly container: Container,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<Request & { providerIdentity?: unknown }>();
    request.providerIdentity = await this.container.providerIdentity.authenticate(request.headers);
    return true;
  }
}
