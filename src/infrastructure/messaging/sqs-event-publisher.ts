import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '@/application/ports/services';
import type { OutboxMessage } from '@/domain/messaging/outbox-message';

/**
 * Publishes outbox events to the events FIFO queue.
 *  - MessageGroupId = walletId (events of one wallet stay ordered per publisher);
 *  - MessageDeduplicationId = eventId, so the broker also absorbs republications within its 5-minute
 *    window. Consumers must still treat delivery as at-least-once and deduplicate by `eventId`.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const data = message.payload['data'] as { walletId?: unknown } | undefined;
    const groupId = typeof data?.walletId === 'string' ? data.walletId : message.aggregateId;
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: groupId,
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
      }),
    );
  }
}

/** Test-only decorator: simulates the process dying after the broker accepted the event. */
export class FaultInjectingPublisher implements EventPublisher {
  constructor(
    private readonly inner: EventPublisher,
    private readonly crashAfterPublish: boolean,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inner.publish(message);
    if (this.crashAfterPublish) {
      process.kill(process.pid, 'SIGKILL');
    }
  }
}
