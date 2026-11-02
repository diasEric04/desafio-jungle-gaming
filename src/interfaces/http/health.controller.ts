import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Container } from '@/infrastructure/container';
import { Public } from './public.decorator';
import { CONTAINER } from './tokens';

@Controller()
export class HealthController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  /** Process is up. Never touches dependencies, so an orchestrator does not restart us for a DB blip. */
  @Public()
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** PostgreSQL and SQS reachable and not shutting down. 503 takes the instance out of rotation. */
  @Public()
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const report = await this.container.readiness.check();
    response.status(report.ready ? 200 : 503);
    return { status: report.ready ? 'ok' : 'unavailable', ...report.checks };
  }

  @Public()
  @Get('metrics')
  async metrics(@Res() response: Response): Promise<void> {
    response.type(this.container.metrics.contentType).send(await this.container.metrics.render());
  }
}
