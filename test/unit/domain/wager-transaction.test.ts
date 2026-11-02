import { describe, expect, test } from 'bun:test';
import { Money } from '@/domain/money/money';
import { FailureCode, retryAdviceFor } from '@/domain/wagering/failure-code';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '@/domain/wagering/wager-transaction';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '@/domain/wagering/wagering.errors';
import { LedgerDirection } from '@/domain/ledger/wallet-ledger-entry';

const at = new Date('2026-01-01T00:00:00Z');
const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const hash = 'a'.repeat(64);

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 't1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: hash,
    walletId: 'w',
    playerId: 'p',
    roundId: 'r',
    gameId: 'g',
    kind: K.Bet,
    money: brl('10.00'),
    createdAt: at,
    ...overrides,
  };
}

describe('WagerTransaction.create', () => {
  test('is born PENDING', () => {
    const t = WagerTransaction.create(props());
    expect(t.status).toBe(S.Pending);
    expect(t.isTerminal()).toBe(false);
    expect(t.matchesPayload(hash)).toBe(true);
    expect(t.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('OPENING cannot be submitted', () => {
    expect(() => WagerTransaction.create(props({ kind: K.Opening }))).toThrow(
      InvalidTransactionError,
    );
  });

  test('the internal provider id is reserved', () => {
    expect(() => WagerTransaction.create(props({ providerId: 'internal' }))).toThrow(
      InvalidTransactionError,
    );
  });

  test('REFUND and ROLLBACK require a reference; BET forbids it', () => {
    expect(() => WagerTransaction.create(props({ kind: K.Refund }))).toThrow(
      /requires referenceExternalTransactionId/,
    );
    expect(() => WagerTransaction.create(props({ kind: K.Rollback }))).toThrow(
      InvalidTransactionError,
    );
    expect(() => WagerTransaction.create(props({ referenceExternalTransactionId: 'x' }))).toThrow(
      /BET cannot reference/,
    );
    expect(WagerTransaction.create(props({ kind: K.Win })).requiresReference()).toBe(false);
    expect(
      WagerTransaction.create(props({ kind: K.Win, referenceExternalTransactionId: 'bet' }))
        .referenceExternalTransactionId,
    ).toBe('bet');
    expect(
      WagerTransaction.create(
        props({ kind: K.Refund, referenceExternalTransactionId: 'bet' }),
      ).requiresReference(),
    ).toBe(true);
  });

  test('no self reference, positive amounts (zero only for LOSS)', () => {
    expect(() =>
      WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'ext-1' })),
    ).toThrow(/itself/);
    expect(() => WagerTransaction.create(props({ money: brl('0.00') }))).toThrow(
      InvalidTransactionError,
    );
    expect(
      WagerTransaction.create(props({ kind: K.Loss, money: brl('0.00') })).affectsBalance(),
    ).toBe(false);
  });

  test('rejects blank / padded / control-char identifiers and bad hashes', () => {
    expect(() => WagerTransaction.create(props({ roundId: '' }))).toThrow(InvalidTransactionError);
    expect(() => WagerTransaction.create(props({ gameId: ' g' }))).toThrow(InvalidTransactionError);
    expect(() => WagerTransaction.create(props({ externalTransactionId: 'a\nb' }))).toThrow(
      InvalidTransactionError,
    );
    expect(() => WagerTransaction.create(props({ payloadHash: 'xyz' }))).toThrow(
      InvalidTransactionError,
    );
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING -> PROCESSED stores balance and reference', () => {
    const t = WagerTransaction.create(props());
    t.markProcessed('ref-id', at, brl('90.00'));
    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe('ref-id');
    expect(t.observedBalance?.amount).toBe('90.00');
    expect(t.isTerminal()).toBe(true);
  });

  test.each([
    ['markProcessed', (t: WagerTransaction) => t.markProcessed(undefined, at, brl('1.00'))],
    ['reject', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, at, brl('1.00'))],
    ['fail', (t: WagerTransaction) => t.fail(FailureCode.InternalError, at)],
  ])('terminal states cannot transition (%s)', (_name, act) => {
    for (const finish of [
      (t: WagerTransaction) => t.markProcessed(undefined, at, brl('1.00')),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, at, brl('1.00')),
      (t: WagerTransaction) => t.fail(FailureCode.InternalError, at),
    ]) {
      const t = WagerTransaction.create(props());
      finish(t);
      expect(() => act(t)).toThrow(InvalidTransactionStateError);
    }
  });

  test('PENDING -> PENDING_REFERENCE -> rescheduled -> PROCESSED', () => {
    const t = WagerTransaction.create(
      props({ kind: K.Refund, referenceExternalTransactionId: 'bet' }),
    );
    t.markPendingReference(brl('5.00'), new Date(at.getTime() + 1000), at);
    expect(t.status).toBe(S.PendingReference);
    expect(t.referenceAttempts).toBe(0);
    t.rescheduleReference(new Date(at.getTime() + 2000), at);
    expect(t.referenceAttempts).toBe(1);
    expect(() => t.markPendingReference(brl('5.00'), at, at)).toThrow(InvalidTransactionStateError);
    t.markProcessed('bet-id', at, brl('15.00'));
    expect(t.status).toBe(S.Processed);
    expect(t.nextAttemptAt).toBeUndefined();
  });

  test('ledger direction follows the kind; ROLLBACK inverts its reference', () => {
    const bet = WagerTransaction.create(props());
    const win = WagerTransaction.create(props({ kind: K.Win }));
    const rollback = WagerTransaction.create(
      props({ kind: K.Rollback, referenceExternalTransactionId: 'x' }),
    );
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransaction.create(props({ kind: K.Loss })).ledgerDirectionFor()).toThrow();
  });
});

describe('FailureCode', () => {
  test('every code maps to retry advice', () => {
    for (const code of Object.values(FailureCode)) {
      expect(retryAdviceFor(code)).toBeDefined();
    }
  });

  test('overdrawing reversals are distinguishable from insufficient funds', () => {
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
    expect(retryAdviceFor(FailureCode.ReversalWouldOverdraw)).not.toBe(
      retryAdviceFor(FailureCode.InsufficientFunds),
    );
  });
});
