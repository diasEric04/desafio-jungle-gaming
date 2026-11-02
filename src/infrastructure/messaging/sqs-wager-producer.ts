import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { uuidv7 } from '@/shared/system';
import type { WagerFields } from '@/shared/wager-input-schema';
import { WAGER_MESSAGE_TYPE } from './wager-message';

export interface ProducedMessage {
  messageId: string;
  body: string;
}

/**
 * Producer side of `WagerTransactionRequested`. Providers publish these in production; here it
 * backs tests, the load test and local experiments. `deduplicationId` can be overridden to force the
 * broker to deliver the same logical message twice (what a retrying producer would do).
 */
export class SqsWagerProducer {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(
    data: WagerFields,
    options: {
      messageId?: string;
      idempotencyKey?: string;
      deduplicationId?: string;
      occurredAt?: Date;
    } = {},
  ): Promise<ProducedMessage> {
    const messageId = options.messageId ?? uuidv7();
    const body = JSON.stringify({
      messageId,
      type: WAGER_MESSAGE_TYPE,
      occurredAt: (options.occurredAt ?? new Date()).toISOString(),
      data: {
        ...data,
        idempotencyKey:
          options.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`,
      },
    });
    await this.sendRaw(body, data.walletId, options.deduplicationId ?? messageId);
    return { messageId, body };
  }

  async sendRaw(body: string, groupId: string, deduplicationId: string = uuidv7()): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }
}
