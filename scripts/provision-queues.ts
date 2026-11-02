import { loadConfig } from '@/config/app-config';
import { provisionQueues } from '@/infrastructure/messaging/queues';
import { createSqsClient } from '@/infrastructure/messaging/sqs-client';

/** Creates the FIFO queues + DLQ redrive policy. Idempotent; the test suites use the same function. */
async function main(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: process.env['DATABASE_URL'] ?? 'unused',
  });
  const client = createSqsClient(config.aws);
  const urls = await provisionQueues(client, config.queues, {
    redriveMaxReceiveCount: config.consumer.maxAttempts + 5,
    visibilityTimeoutSeconds: config.consumer.visibilityTimeoutSeconds,
  });
  console.log('queues ready:', urls);
  client.destroy();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
