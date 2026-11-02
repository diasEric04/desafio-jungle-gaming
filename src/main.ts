import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { loadConfig } from '@/config/app-config';
import { uuidv7 } from '@/shared/system';
import { AppModule } from '@/interfaces/app.module';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, {
    logger: config.logLevel === 'silent' ? false : ['error', 'warn'],
  });

  // Every request carries a correlation id: taken from the caller or generated here.
  app.use((request: Request, response: Response, next: NextFunction) => {
    const id = String(request.headers['x-correlation-id'] || uuidv7());
    request.headers['x-correlation-id'] = id;
    response.setHeader('x-correlation-id', id);
    next();
  });

  // SIGTERM / SIGINT -> OnModuleDestroy (drain consumer + workers) -> close the HTTP server.
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
