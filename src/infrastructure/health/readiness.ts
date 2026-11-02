import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: { database: CheckStatus; sqs: CheckStatus; shuttingDown: boolean };
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('health check timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Readiness = PostgreSQL and SQS reachable and the instance not draining. Liveness never touches them. */
export class ReadinessChecker {
  private shuttingDown = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient | undefined,
    private readonly wagerQueueUrl: string | undefined,
  ) {}

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  async check(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([this.checkDatabase(), this.checkSqs()]);
    return {
      ready: database === 'up' && sqs === 'up' && !this.shuttingDown,
      checks: { database, sqs, shuttingDown: this.shuttingDown },
    };
  }

  private async checkDatabase(): Promise<CheckStatus> {
    try {
      await withTimeout(this.orm.em.fork().execute('SELECT 1'), CHECK_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkSqs(): Promise<CheckStatus> {
    if (!this.sqs || !this.wagerQueueUrl) return 'up';
    try {
      await withTimeout(
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.wagerQueueUrl,
            AttributeNames: ['QueueArn'],
          }),
        ),
        CHECK_TIMEOUT_MS,
      );
      return 'up';
    } catch {
      return 'down';
    }
  }
}
