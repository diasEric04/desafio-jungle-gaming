import { describe, expect, test } from 'bun:test';
import {
  classifyDbError,
  isRetryableInTransaction,
  type DbErrorKind,
} from '@/infrastructure/persistence/db-errors';

describe('classifyDbError', () => {
  test.each<[string, DbErrorKind]>([
    ['40P01', 'deadlock'],
    ['40001', 'serialization'],
    ['55P03', 'lock_timeout'],
    ['57014', 'statement_timeout'],
    ['08006', 'connection'],
    ['57P01', 'connection'],
    ['53300', 'connection'],
    ['ECONNREFUSED', 'connection'],
    ['23505', 'other'],
  ])('SQLSTATE %s -> %s', (code, kind) => {
    expect(classifyDbError(Object.assign(new Error('x'), { code }))).toBe(kind);
  });

  test('looks through wrapped errors and pool messages', () => {
    expect(
      classifyDbError(
        new Error('wrap', { cause: Object.assign(new Error('inner'), { code: '40P01' }) }),
      ),
    ).toBe('deadlock');
    expect(
      classifyDbError(
        new Error('Knex: Timeout acquiring a connection. The pool is probably full.'),
      ),
    ).toBe('connection');
    expect(classifyDbError(new Error('Connection terminated unexpectedly'))).toBe('connection');
    expect(classifyDbError(new Error('boom'))).toBe('other');
    expect(classifyDbError(undefined)).toBe('other');
  });

  test('only deadlock and serialization are re-run inside the unit of work', () => {
    expect(isRetryableInTransaction('deadlock')).toBe(true);
    expect(isRetryableInTransaction('serialization')).toBe(true);
    expect(isRetryableInTransaction('lock_timeout')).toBe(false);
    expect(isRetryableInTransaction('connection')).toBe(false);
  });
});
