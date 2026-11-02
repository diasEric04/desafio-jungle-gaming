import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Metrics } from '@/application/ports/metrics';
import type { Logger } from '@/application/ports/services';
import type { ProcessWagerTransactionUseCase } from '@/application/use-cases/process-wager-transaction';
import type { AppConfig } from '@/config/app-config';
import { WagerTransactionKind } from '@/domain/wagering/wager-transaction';
import { exponentialDelayMs } from '@/domain/shared/backoff';
import { classifyConsumerError } from './error-classification';
import { MessageValidationError } from './message-errors';
import { parseWagerMessage, ParsedWagerMessage } from './wager-message';

export interface WagerConsumerDeps {
  client: SQSClient;
  queueUrl: string;
  dlqUrl: string;
  useCase: ProcessWagerTransactionUseCase;
  config: AppConfig['consumer'];
  faultExitBeforeAck: boolean;
  shutdownTimeoutMs: number;
  metrics: Metrics;
  logger: Logger;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SQS FIFO consumer. Guarantees:
 *  - the message is deleted (acked) ONLY after the use case committed;
 *  - redelivery is harmless: the inbox row (same SQL transaction as the effect) and the idempotency
 *    key make a second processing a no-op;
 *  - failures are routed: permanent -> DLQ now; transient -> visibility timeout with exponential
 *    backoff, DLQ once CONSUMER_MAX_ATTEMPTS receives are spent;
 *  - on stop: no new receives, the message in flight finishes, unstarted ones go back to the queue.
 *
 * FIFO ordering per MessageGroupId is an optimization only; correctness never depends on it.
 */
export class SqsWagerConsumer {
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];
  private stopping = false;

  constructor(private readonly deps: WagerConsumerDeps) {}

  start(): void {
    if (this.loops.length > 0) return;
    for (let i = 0; i < this.deps.config.concurrency; i++) {
      this.loops.push(this.pollLoop());
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.deps.logger.warn('consumer did not drain in time', {
          timeoutMs: this.deps.shutdownTimeoutMs,
        });
        resolve();
      }, this.deps.shutdownTimeoutMs);
    });
    await Promise.race([Promise.allSettled(this.loops), timeout]);
    clearTimeout(timer);
  }

  private async pollLoop(): Promise<void> {
    const { client, queueUrl, config, logger, metrics } = this.deps;
    while (!this.stopping) {
      let messages: Message[] = [];
      try {
        const out = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: config.waitSeconds,
            VisibilityTimeout: config.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = out.Messages ?? [];
      } catch (error) {
        if (this.stopping) break;
        metrics.retry('sqs_consumer', 'receive_failed');
        logger.warn('sqs receive failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(1_000 + Math.random() * 500);
        continue;
      }

      // One batch is processed sequentially, in the order SQS delivered it (per-group FIFO order).
      for (const message of messages) {
        if (this.stopping) {
          await this.giveBack(message);
          continue;
        }
        await this.handle(message);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const { useCase, config, logger, metrics } = this.deps;
    const receiveCount = Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1');

    let parsed: ParsedWagerMessage;
    try {
      parsed = parseWagerMessage(message.Body);
    } catch (error) {
      await this.deadLetter(message, 'MALFORMED_MESSAGE', error);
      return;
    }
    const { envelope, payloadHash } = parsed;
    const { data } = envelope;
    const log = logger.child({
      correlationId: envelope.messageId,
      messageId: envelope.messageId,
      walletId: data.walletId,
      providerId: data.providerId,
    });

    try {
      const result = await useCase.execute({
        idempotencyKey: data.idempotencyKey,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind as WagerTransactionKind,
        money: data.money,
        ...(data.referenceExternalTransactionId !== undefined
          ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
          : {}),
        correlationId: envelope.messageId,
        source: 'sqs',
        inbox: { consumerName: config.name, messageId: envelope.messageId, payloadHash },
      });

      // The effect is committed. A crash right here only causes a redelivery, which the inbox absorbs.
      if (this.deps.faultExitBeforeAck) {
        process.kill(process.pid, 'SIGKILL');
      }
      await this.ack(message);
      log.debug('message acknowledged', {
        transactionId: result.transactionId,
        status: result.status,
      });
    } catch (error) {
      const { disposition, reason } = classifyConsumerError(error);
      if (disposition === 'PERMANENT') {
        await this.deadLetter(message, reason, error);
        return;
      }
      if (receiveCount >= config.maxAttempts) {
        await this.deadLetter(message, 'RETRIES_EXHAUSTED', error);
        return;
      }
      const delaySeconds = Math.max(
        1,
        Math.ceil(
          exponentialDelayMs(receiveCount - 1, {
            baseDelayMs: config.retryBaseSeconds * 1000,
            maxDelayMs: config.retryMaxSeconds * 1000,
          }) / 1000,
        ),
      );
      metrics.retry('sqs_consumer', reason);
      log.warn('message processing failed, retrying with backoff', {
        reason,
        receiveCount,
        delaySeconds,
      });
      await this.changeVisibility(message, delaySeconds);
    }
  }

  private async ack(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.deps.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.deps.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async deadLetter(message: Message, reason: string, error: unknown): Promise<void> {
    const { client, dlqUrl, logger, metrics } = this.deps;
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await client.send(
        new SendMessageCommand({
          QueueUrl: dlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.['MessageGroupId'] ?? 'dead-letter',
          MessageDeduplicationId: `${message.MessageId ?? 'unknown'}:dlq`,
          MessageAttributes: {
            failureReason: { DataType: 'String', StringValue: reason },
            failureDetail: { DataType: 'String', StringValue: detail.slice(0, 500) },
            originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
            receiveCount: {
              DataType: 'Number',
              StringValue: message.Attributes?.['ApproximateReceiveCount'] ?? '1',
            },
          },
        }),
      );
      await this.ack(message);
      metrics.dlqMessage(reason);
      logger.error('message sent to DLQ', {
        reason,
        messageId: message.MessageId,
        malformed: error instanceof MessageValidationError,
        detail: detail.slice(0, 200),
      });
    } catch (dlqError) {
      // DLQ unavailable: leave the message in the queue; it is received again later.
      logger.error('could not move message to DLQ, leaving it for redelivery', {
        reason,
        messageId: message.MessageId,
        error: dlqError instanceof Error ? dlqError.message : String(dlqError),
      });
    }
  }

  private async giveBack(message: Message): Promise<void> {
    await this.changeVisibility(message, 0);
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    if (!message.ReceiptHandle) return;
    try {
      await this.deps.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.deps.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.deps.logger.warn('could not change message visibility', {
        messageId: message.MessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
