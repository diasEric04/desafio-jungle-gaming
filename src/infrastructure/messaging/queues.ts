import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  SQSClient,
} from '@aws-sdk/client-sqs';

export interface QueueNames {
  wager: string;
  dlq: string;
  events: string;
}

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

export interface ProvisionOptions {
  /** SQS-level redrive threshold; a backstop above the application's own CONSUMER_MAX_ATTEMPTS. */
  redriveMaxReceiveCount?: number;
  visibilityTimeoutSeconds?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function createFifoQueue(
  client: SQSClient,
  name: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const out = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...extra },
    }),
  );
  if (!out.QueueUrl) throw new Error(`CreateQueue returned no url for ${name}`);
  return out.QueueUrl;
}

/**
 * Idempotent: creates the DLQ, the main queue (with a redrive policy pointing at the DLQ) and the
 * events queue. Used by `scripts/provision-queues.ts` and by the test suites.
 */
export async function provisionQueues(
  client: SQSClient,
  names: QueueNames,
  options: ProvisionOptions = {},
): Promise<QueueUrls> {
  const dlq = await createFifoQueue(client, names.dlq);
  const attrs = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = attrs.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('DLQ has no ARN');

  const wager = await createFifoQueue(client, names.wager, {
    VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 30),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: options.redriveMaxReceiveCount ?? 10,
    }),
  });
  const events = await createFifoQueue(client, names.events);
  return { wager, dlq, events };
}

/** Looks the queues up by name, waiting for them to appear (they are provisioned by a one-shot job). */
export async function resolveQueueUrls(
  client: SQSClient,
  names: QueueNames,
  options: { timeoutMs?: number } = {},
): Promise<QueueUrls> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const lookup = async (name: string): Promise<string> => {
    for (;;) {
      try {
        const out = await client.send(new GetQueueUrlCommand({ QueueName: name }));
        if (out.QueueUrl) return out.QueueUrl;
      } catch (error) {
        const missing =
          error instanceof QueueDoesNotExist ||
          (error as { name?: string }).name === 'QueueDoesNotExist';
        const unreachable = !missing;
        if (Date.now() > deadline) throw error;
        await sleep(unreachable ? 1_000 : 500);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`queue ${name} did not appear in time`);
      await sleep(500);
    }
  };
  const [wager, dlq, events] = await Promise.all([
    lookup(names.wager),
    lookup(names.dlq),
    lookup(names.events),
  ]);
  return { wager, dlq, events };
}
