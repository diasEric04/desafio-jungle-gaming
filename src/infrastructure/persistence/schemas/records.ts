import { EntitySchema } from '@mikro-orm/core';

/**
 * Persistence records: plain data shapes that mirror the tables. They are NOT the domain model
 * (that one is encapsulated and decorator-free); repositories map between the two. Money is stored
 * as `numeric(20,2)` and travels as an exact decimal string, then is rebuilt as `Money`.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  observedBalance!: string | null;
  referenceAttempts!: number;
  nextAttemptAt!: Date | null;
  leaseUntil!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt!: Date | null;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
  lastError!: string | null;
}

const money = { type: 'string', columnType: 'numeric(20,2)' } as const;
const timestamp = { type: 'Date', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: money,
    version: { type: 'number', columnType: 'integer' },
    createdAt: { ...timestamp, fieldName: 'created_at' },
    updatedAt: { ...timestamp, fieldName: 'updated_at' },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id', length: 64 },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id', length: 128 },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', length: 256 },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id', length: 128 },
    gameId: { type: 'string', fieldName: 'game_id', length: 128 },
    kind: { type: 'string', length: 16 },
    amount: money,
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      length: 128,
      nullable: true,
    },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string', length: 24 },
    failureCode: { type: 'string', fieldName: 'failure_code', length: 48, nullable: true },
    observedBalance: { ...money, fieldName: 'observed_balance', nullable: true },
    referenceAttempts: { type: 'number', fieldName: 'reference_attempts', columnType: 'integer' },
    nextAttemptAt: { ...timestamp, fieldName: 'next_attempt_at', nullable: true },
    leaseUntil: { ...timestamp, fieldName: 'lease_until', nullable: true },
    createdAt: { ...timestamp, fieldName: 'created_at' },
    updatedAt: { ...timestamp, fieldName: 'updated_at' },
    processedAt: { ...timestamp, fieldName: 'processed_at', nullable: true },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', length: 6 },
    amount: money,
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { ...money, fieldName: 'balance_before' },
    balanceAfter: { ...money, fieldName: 'balance_after' },
    walletVersion: { type: 'number', fieldName: 'wallet_version', columnType: 'integer' },
    createdAt: { ...timestamp, fieldName: 'created_at' },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', length: 128, primary: true },
    messageId: { type: 'string', fieldName: 'message_id', length: 256, primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    receivedAt: { ...timestamp, fieldName: 'received_at' },
    processedAt: { ...timestamp, fieldName: 'processed_at', nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type', length: 128 },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { ...timestamp, fieldName: 'occurred_at' },
    attempts: { type: 'number', columnType: 'integer' },
    nextAttemptAt: { ...timestamp, fieldName: 'next_attempt_at' },
    publishedAt: { ...timestamp, fieldName: 'published_at', nullable: true },
    lastError: { type: 'string', fieldName: 'last_error', length: 500, nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
