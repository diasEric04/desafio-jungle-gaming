import { describe, expect, test } from 'bun:test';
import { JsonLogger, redact } from '@/infrastructure/observability/json-logger';

function capture(level: 'debug' | 'info' | 'warn' | 'error' | 'silent' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger(level, {}, (line) => lines.push(JSON.parse(line)));
  return { lines, logger };
}

describe('JsonLogger', () => {
  test('emits one JSON object with context ids and child bindings', () => {
    const { lines, logger } = capture();
    logger
      .child({ providerId: 'provider-a' })
      .info('handled', {
        correlationId: 'c1',
        transactionId: 't1',
        walletId: 'w1',
        messageId: 'm1',
      });
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'handled',
      correlationId: 'c1',
      transactionId: 't1',
      walletId: 'w1',
      messageId: 'm1',
      providerId: 'provider-a',
    });
    expect(typeof lines[0]!.time).toBe('string');
  });

  test('never logs money, payloads or credentials', () => {
    const { lines, logger } = capture();
    logger.info('x', {
      money: { amount: '25.00', currency: 'BRL' },
      balance: '10.00',
      nested: { payload: { a: 1 }, ok: 'yes' },
      authorization: 'Bearer abc',
    });
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain('25.00');
    expect(text).not.toContain('Bearer');
    expect(lines[0]!.nested).toEqual({ payload: '[REDACTED]', ok: 'yes' });
  });

  test('respects the level', () => {
    const { lines, logger } = capture('warn');
    logger.info('hidden');
    logger.warn('shown');
    expect(lines.map((l) => l.msg)).toEqual(['shown']);
    const silent = capture('silent');
    silent.logger.error('nothing');
    expect(silent.lines).toHaveLength(0);
  });

  test('serializes errors without stack and truncates deep objects', () => {
    expect(redact(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
    expect(JSON.stringify(redact({ a: { b: { c: { d: 1 } } } }))).toContain('[TRUNCATED]');
  });
});
