import {
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { loadConfig } from '@/config/app-config';
import { Container, createContainer } from '@/infrastructure/container';
import { AuthGuard } from './http/auth.guard';
import { ErrorFilter } from './http/filters/error.filter';
import { HealthController } from './http/health.controller';
import { RequestLoggingInterceptor } from './http/request-logging.interceptor';
import { CONTAINER } from './http/tokens';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';

/** Starts the background roles once the HTTP app is up and drains them on shutdown. */
@Injectable()
export class LifecycleService implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  onApplicationBootstrap(): void {
    this.container.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.container.stop();
  }
}

@Module({
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    {
      provide: CONTAINER,
      useFactory: async (): Promise<Container> => createContainer(loadConfig()),
    },
    LifecycleService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule {}
