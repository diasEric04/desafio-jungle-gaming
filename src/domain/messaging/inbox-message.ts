import { DomainError } from '../errors';

export class InboxMessageConflictError extends DomainError {
  readonly code = 'INBOX_MESSAGE_CONFLICT';
  readonly category = 'CONFLICT' as const;

  constructor(consumerName: string, messageId: string) {
    super(`Message ${messageId} was already received by ${consumerName} with a different payload`);
  }
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

/**
 * Persistent record that a consumer already handled a broker message. It is written in the same SQL
 * transaction as the financial effect, so "row exists" means "effect committed".
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      return;
    }
    this._processedAt = at;
  }
}
