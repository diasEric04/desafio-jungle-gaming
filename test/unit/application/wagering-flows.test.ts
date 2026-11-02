import { describe, expect, test } from 'bun:test';
import { createHarness } from '../../support/harness';
import {
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '@/domain/wagering/wager-transaction';
import { FailureCode } from '@/domain/wagering/failure-code';
import { IdempotencyConflictError } from '@/domain/wagering/wagering.errors';
import { InvalidMoneyError } from '@/domain/money/money';
import { WalletAlreadyExistsError, WalletNotFoundError } from '@/domain/wallet/wallet.errors';
import { InboxMessageConflictError } from '@/domain/messaging/inbox-message';

async function setup(balance = '100.00') {
  const h = createHarness();
  const wallet = await h.openWallet(balance);
  const balanceNow = () => h.db.wallets.get(wallet.id)!.balance.amount;
  const consistent = () =>
    expect(h.db.ledgerBalance(wallet.id, 'BRL').amount).toBe(
      h.db.wallets.get(wallet.id)!.balance.amount,
    );
  return { h, wallet, balanceNow, consistent };
}

describe('wallet creation', () => {
  test('opening balance creates OPENING transaction, CREDIT entry and event atomically', async () => {
    const { h, wallet, consistent } = await setup('1000.00');
    expect(wallet.version).toBe(1);
    expect(h.db.ledger).toHaveLength(1);
    expect([...h.db.transactions.values()][0]!.kind).toBe(K.Opening);
    expect(h.db.outboxEventTypes()).toEqual(['WalletBalanceChanged']);
    consistent();
  });

  test('zero balance creates no ledger entry; duplicate player+currency conflicts', async () => {
    const h = createHarness();
    await h.openWallet('0.00');
    expect(h.db.ledger).toHaveLength(0);
    await expect(h.openWallet('5.00')).rejects.toThrow(WalletAlreadyExistsError);
    expect(h.db.wallets.size).toBe(1);
  });
});

describe('BET / WIN / LOSS', () => {
  test('BET debits once and records the ledger', async () => {
    const { h, wallet, balanceNow, consistent } = await setup();
    const r = await h.process.execute(h.command(wallet.id, K.Bet, '25.00'));
    expect(r.status).toBe(S.Processed);
    expect(r.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(r.idempotentReplay).toBe(false);
    expect(balanceNow()).toBe('75.00');
    expect(h.db.ledger).toHaveLength(2);
    consistent();
  });

  test('insufficient funds is persisted as REJECTED, no ledger, no balance change', async () => {
    const { h, wallet, balanceNow, consistent } = await setup();
    const r = await h.process.execute(h.command(wallet.id, K.Bet, '100.01'));
    expect(r.status).toBe(S.Rejected);
    expect(r.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(r.retryAdvice).toBeDefined();
    expect(balanceNow()).toBe('100.00');
    expect(h.db.ledger).toHaveLength(1);
    expect(h.db.outboxEventTypes()).toContain('WagerTransactionRejected');
    consistent();
  });

  test('WIN credits; LOSS records without moving money and emits no balance event', async () => {
    const { h, wallet, balanceNow, consistent } = await setup();
    await h.process.execute(h.command(wallet.id, K.Win, '40.00'));
    expect(balanceNow()).toBe('140.00');
    const before = h.db.ledger.length;
    const loss = await h.process.execute(h.command(wallet.id, K.Loss, '10.00'));
    expect(loss.status).toBe(S.Processed);
    expect(h.db.ledger).toHaveLength(before);
    expect(balanceNow()).toBe('140.00');
    const changed = h.db.outboxEventTypes().filter((t) => t === 'WalletBalanceChanged');
    expect(changed).toHaveLength(2); // opening + WIN
    expect(h.db.outboxEventTypes().filter((t) => t === 'WagerTransactionProcessed')).toHaveLength(
      2,
    );
    consistent();
  });

  test('wrong player and wrong currency are rejected, not applied', async () => {
    const { h, wallet, balanceNow } = await setup();
    const a = await h.process.execute(
      h.command(wallet.id, K.Bet, '1.00', { playerId: 'someone-else' }),
    );
    expect(a.failureCode).toBe(FailureCode.PlayerMismatch);
    const b = await h.process.execute(
      h.command(wallet.id, K.Bet, '1.00', { money: { amount: '1.00', currency: 'USD' } }),
    );
    expect(b.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(balanceNow()).toBe('100.00');
  });

  test('unknown wallet raises and leaves nothing behind; invalid money fails before the database', async () => {
    const { h } = await setup();
    await expect(
      h.process.execute(
        h.command('0192f291-27dd-7d3f-8071-5f8685deef37', K.Bet, '1.00', {
          inbox: { consumerName: 'c', messageId: 'm1', payloadHash: 'h' },
        }),
      ),
    ).rejects.toThrow(WalletNotFoundError);
    expect(h.db.inbox.size).toBe(0); // rolled back with the rest
    await expect(h.process.execute(h.command('x', K.Bet, '1.234'))).rejects.toThrow(
      InvalidMoneyError,
    );
  });
});

describe('idempotency', () => {
  test('same request twice => original result, single debit', async () => {
    const { h, wallet, balanceNow, consistent } = await setup();
    const cmd = h.command(wallet.id, K.Bet, '30.00');
    const first = await h.process.execute(cmd);
    await h.process.execute(h.command(wallet.id, K.Bet, '10.00')); // balance moves on
    const replay = await h.process.execute(cmd);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual({ amount: '70.00', currency: 'BRL' }); // balance observed then, not now
    expect(balanceNow()).toBe('60.00');
    expect(h.db.ledger).toHaveLength(3);
    expect(h.metrics.counts.get('duplicate:http')).toBe(1);
    consistent();
  });

  test('replay of a rejection returns the same rejection', async () => {
    const { h, wallet } = await setup('10.00');
    const cmd = h.command(wallet.id, K.Bet, '50.00');
    const first = await h.process.execute(cmd);
    await h.process.execute(h.command(wallet.id, K.Win, '100.00'));
    const replay = await h.process.execute(cmd);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
  });

  test('same key with another payload (amount, kind, or key) is a conflict, not a replay', async () => {
    const { h, wallet, balanceNow } = await setup();
    const cmd = h.command(wallet.id, K.Bet, '30.00');
    await h.process.execute(cmd);
    await expect(
      h.process.execute({ ...cmd, money: { amount: '31.00', currency: 'BRL' } }),
    ).rejects.toThrow(IdempotencyConflictError);
    await expect(h.process.execute({ ...cmd, kind: K.Win })).rejects.toThrow(
      IdempotencyConflictError,
    );
    await expect(h.process.execute({ ...cmd, idempotencyKey: 'another-key' })).rejects.toThrow(
      IdempotencyConflictError,
    );
    expect(balanceNow()).toBe('70.00');
  });

  test('amount "30" and "30.00" are the same payload', async () => {
    const { h, wallet } = await setup();
    const cmd = h.command(wallet.id, K.Bet, '30.00');
    await h.process.execute(cmd);
    const replay = await h.process.execute({ ...cmd, money: { amount: '30', currency: 'BRL' } });
    expect(replay.idempotentReplay).toBe(true);
  });

  test('inbox: redelivered broker message does not repeat effects; reused messageId with other body conflicts', async () => {
    const { h, wallet, balanceNow } = await setup();
    const cmd = h.command(wallet.id, K.Bet, '30.00', {
      source: 'sqs',
      inbox: { consumerName: 'wager', messageId: 'msg-1', payloadHash: 'h1' },
    });
    const first = await h.process.execute(cmd);
    const again = await h.process.execute(cmd);
    expect(again.idempotentReplay).toBe(true);
    expect(again.transactionId).toBe(first.transactionId);
    expect(balanceNow()).toBe('70.00');
    await expect(
      h.process.execute({
        ...cmd,
        inbox: { consumerName: 'wager', messageId: 'msg-1', payloadHash: 'other' },
      }),
    ).rejects.toThrow(InboxMessageConflictError);
    // HTTP and SQS share idempotency: the same business request over HTTP is a replay too.
    const viaHttp = await h.process.execute(
      h.command(wallet.id, K.Bet, '30.00', {
        externalTransactionId: cmd.externalTransactionId,
        source: 'http',
      }),
    );
    expect(viaHttp.idempotentReplay).toBe(true);
  });
});

describe('REFUND / ROLLBACK', () => {
  test('REFUND credits back a processed BET exactly once', async () => {
    const { h, wallet, balanceNow, consistent } = await setup();
    await h.process.execute(
      h.command(wallet.id, K.Bet, '25.00', { externalTransactionId: 'bet-1' }),
    );
    const refund = await h.process.execute(
      h.command(wallet.id, K.Refund, '25.00', {
        externalTransactionId: 'ref-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(refund.status).toBe(S.Processed);
    expect(balanceNow()).toBe('100.00');
    const second = await h.process.execute(
      h.command(wallet.id, K.Refund, '25.00', {
        externalTransactionId: 'ref-2',
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(second.failureCode).toBe(FailureCode.AlreadyReversed);
    // a ROLLBACK of the same BET would double-credit: also refused
    const rollback = await h.process.execute(
      h.command(wallet.id, K.Rollback, '25.00', {
        externalTransactionId: 'rb-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(rollback.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(balanceNow()).toBe('100.00');
    consistent();
  });

  test('ROLLBACK inverts WIN (debit) and BET (credit); overdraw is a distinct rejection', async () => {
    const { h, wallet, balanceNow, consistent } = await setup('50.00');
    await h.process.execute(
      h.command(wallet.id, K.Win, '30.00', { externalTransactionId: 'win-1' }),
    );
    await h.process.execute(
      h.command(wallet.id, K.Bet, '80.00', { externalTransactionId: 'bet-1' }),
    );
    expect(balanceNow()).toBe('0.00');
    const overdraw = await h.process.execute(
      h.command(wallet.id, K.Rollback, '30.00', {
        externalTransactionId: 'rb-win',
        referenceExternalTransactionId: 'win-1',
      }),
    );
    expect(overdraw.status).toBe(S.Rejected);
    expect(overdraw.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(balanceNow()).toBe('0.00');
    const rbBet = await h.process.execute(
      h.command(wallet.id, K.Rollback, '80.00', {
        externalTransactionId: 'rb-bet',
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(rbBet.status).toBe(S.Processed);
    expect(balanceNow()).toBe('80.00');
    const rbWin = await h.process.execute(
      h.command(wallet.id, K.Rollback, '30.00', {
        externalTransactionId: 'rb-win-2',
        referenceExternalTransactionId: 'win-1',
      }),
    );
    expect(rbWin.status).toBe(S.Processed);
    expect(balanceNow()).toBe('50.00');
    consistent();
  });

  test('reference validation: kind, amount, round, rejected reference', async () => {
    const { h, wallet, balanceNow } = await setup();
    await h.process.execute(
      h.command(wallet.id, K.Bet, '25.00', { externalTransactionId: 'bet-1' }),
    );
    await h.process.execute(
      h.command(wallet.id, K.Win, '10.00', { externalTransactionId: 'win-1' }),
    );
    await h.process.execute(
      h.command(wallet.id, K.Bet, '999.00', { externalTransactionId: 'bet-big' }),
    ); // rejected
    const run = (kind: K, amount: string, id: string, ref: string, extra = {}) =>
      h.process.execute(
        h.command(wallet.id, kind, amount, {
          externalTransactionId: id,
          referenceExternalTransactionId: ref,
          ...extra,
        }),
      );
    expect((await run(K.Refund, '10.00', 'r1', 'win-1')).failureCode).toBe(
      FailureCode.InvalidReferenceKind,
    );
    expect((await run(K.Refund, '24.00', 'r2', 'bet-1')).failureCode).toBe(
      FailureCode.AmountMismatch,
    );
    expect((await run(K.Refund, '25.00', 'r3', 'bet-1', { roundId: 'round-2' })).failureCode).toBe(
      FailureCode.ReferenceMismatch,
    );
    expect((await run(K.Refund, '999.00', 'r4', 'bet-big')).failureCode).toBe(
      FailureCode.ReferenceNotProcessed,
    );
    expect(balanceNow()).toBe('85.00');
  });

  test('WIN may reference its BET; a reversed BET cannot be won afterwards', async () => {
    const { h, wallet } = await setup();
    await h.process.execute(
      h.command(wallet.id, K.Bet, '10.00', { externalTransactionId: 'bet-1' }),
    );
    const win = await h.process.execute(
      h.command(wallet.id, K.Win, '20.00', {
        externalTransactionId: 'w1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(win.status).toBe(S.Processed);
    await h.process.execute(
      h.command(wallet.id, K.Bet, '10.00', { externalTransactionId: 'bet-2' }),
    );
    await h.process.execute(
      h.command(wallet.id, K.Refund, '10.00', {
        externalTransactionId: 'ref-2',
        referenceExternalTransactionId: 'bet-2',
      }),
    );
    const late = await h.process.execute(
      h.command(wallet.id, K.Win, '5.00', {
        externalTransactionId: 'w2',
        referenceExternalTransactionId: 'bet-2',
      }),
    );
    expect(late.failureCode).toBe(FailureCode.AlreadyReversed);
  });
});

describe('out-of-order references (PENDING_REFERENCE)', () => {
  test('REFUND before its BET waits, then applies when the BET lands', async () => {
    const { h, wallet, balanceNow, consistent } = await setup();
    const refund = await h.process.execute(
      h.command(wallet.id, K.Refund, '25.00', {
        externalTransactionId: 'ref-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(refund.status).toBe(S.PendingReference);
    expect(balanceNow()).toBe('100.00');
    expect(h.db.outboxEventTypes()).toContain('WagerTransactionPendingReference');

    await h.process.execute(
      h.command(wallet.id, K.Bet, '25.00', { externalTransactionId: 'bet-1' }),
    );
    expect(balanceNow()).toBe('75.00');

    // the BET waking its dependent makes it immediately claimable
    const claims = await h.claim.execute(10);
    expect(claims).toHaveLength(1);
    expect(await h.reprocess.execute(claims[0]!, 'c')).toBe('PROCESSED');
    expect(balanceNow()).toBe('100.00');
    expect(h.db.transactions.get(refund.transactionId)!.status).toBe(S.Processed);
    expect(await h.claim.execute(10)).toHaveLength(0);
    consistent();
  });

  test('replaying a pending request returns it pending, without a second row', async () => {
    const { h, wallet } = await setup();
    const cmd = h.command(wallet.id, K.Rollback, '1.00', {
      referenceExternalTransactionId: 'nope',
    });
    const a = await h.process.execute(cmd);
    const b = await h.process.execute(cmd);
    expect(b).toEqual({ ...a, idempotentReplay: true });
    expect(
      h.db.outboxEventTypes().filter((t) => t === 'WagerTransactionPendingReference'),
    ).toHaveLength(1);
  });

  test('reference that never arrives is rejected after the attempt budget, with an event', async () => {
    const { h, wallet } = await setup();
    const pending = await h.process.execute(
      h.command(wallet.id, K.Rollback, '1.00', {
        externalTransactionId: 'rb',
        referenceExternalTransactionId: 'ghost',
      }),
    );
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      h.clock.advance(60_000);
      for (const claim of await h.claim.execute(10))
        outcomes.push(await h.reprocess.execute(claim, 'c'));
    }
    expect(outcomes).toEqual(['PENDING_REFERENCE', 'PENDING_REFERENCE', 'REJECTED']);
    const stored = h.db.transactions.get(pending.transactionId)!;
    expect(stored.status).toBe(S.Rejected);
    expect(stored.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(h.db.outboxEventTypes()).toContain('WagerTransactionRejected');
  });

  test('reprocessing a transaction that is no longer pending is a no-op', async () => {
    const { h, wallet } = await setup();
    const r = await h.process.execute(h.command(wallet.id, K.Bet, '1.00'));
    expect(
      await h.reprocess.execute({ transactionId: r.transactionId, walletId: wallet.id }, 'c'),
    ).toBe('SKIPPED');
  });
});

describe('outbox relay and reconciliation', () => {
  test('publishes pending events once; failures back off and retry', async () => {
    let failing = true;
    const sent: string[] = [];
    const h = createHarness({
      publisher: {
        publish: async (m) => {
          if (failing) throw new Error('sqs down');
          sent.push(m.id);
        },
      },
    });
    const wallet = await h.openWallet('10.00');
    await h.process.execute(h.command(wallet.id, K.Bet, '1.00'));
    const pending = h.db.outbox.size;

    expect(await h.publishOutbox.execute(10)).toEqual({ published: 0, failed: pending });
    expect(await h.publishOutbox.execute(10)).toEqual({ published: 0, failed: 0 }); // not due yet

    failing = false;
    h.clock.advance(120_000);
    expect(await h.publishOutbox.execute(10)).toEqual({ published: pending, failed: 0 });
    expect(await h.publishOutbox.execute(10)).toEqual({ published: 0, failed: 0 });
    expect(new Set(sent).size).toBe(pending);
  });

  test('reconciliation reports consistency and flags (never fixes) divergence', async () => {
    const { h, wallet } = await setup();
    await h.process.execute(h.command(wallet.id, K.Bet, '25.00'));
    const ok = await h.reconcile.execute(wallet.id, 'c');
    expect(ok).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      difference: { amount: '0.00' },
    });

    const state = h.db.wallets.get(wallet.id)!;
    h.db.wallets.set(wallet.id, { ...state, balance: state.balance.add(await moneyOf('1.00')) });
    const bad = await h.reconcile.execute(wallet.id, 'c');
    expect(bad.consistent).toBe(false);
    expect(bad.difference.amount).toBe('1.00');
    expect(h.metrics.counts.get('reconciliation:divergence')).toBe(1);
    expect(h.db.wallets.get(wallet.id)!.balance.amount).toBe('76.00'); // untouched
  });
});

async function moneyOf(amount: string) {
  const { Money } = await import('@/domain/money/money');
  return Money.from({ amount, currency: 'BRL' });
}
