import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from '@/config/app-config';

const base = { DATABASE_URL: 'postgres://u:p@h/db' };

describe('loadConfig', () => {
  test('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.roles).toEqual({
      consumer: true,
      outboxPublisher: true,
      pendingReferenceWorker: true,
    });
    expect(c.queues.wager).toBe('wager-transactions.fifo');
    expect(c.pendingReference.ttlSeconds).toBe(600);
  });

  test('requires DATABASE_URL and validates numbers/booleans', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, ENABLE_QUEUE_CONSUMER: 'maybe' })).toThrow(
      /ENABLE_QUEUE_CONSUMER/,
    );
    expect(() => loadConfig({ ...base, DB_POOL_MIN: '30', DB_POOL_MAX: '5' })).toThrow(
      /DB_POOL_MIN/,
    );
  });

  test('roles can be switched off per instance', () => {
    const c = loadConfig({ ...base, ENABLE_QUEUE_CONSUMER: 'false', ENABLE_OUTBOX_PUBLISHER: '0' });
    expect(c.roles.consumer).toBe(false);
    expect(c.roles.outboxPublisher).toBe(false);
    expect(c.roles.pendingReferenceWorker).toBe(true);
  });

  test('fault injection is refused in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', FAULT_EXIT_BEFORE_ACK: 'true' }),
    ).toThrow(/production/);
    expect(
      loadConfig({ ...base, NODE_ENV: 'test', FAULT_EXIT_BEFORE_ACK: 'true' }).faults.exitBeforeAck,
    ).toBe(true);
  });
});
