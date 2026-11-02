import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { WalletBalanceChanged } from '@/domain/messaging/events/wager-events';
import { Money, MoneyProps } from '@/domain/money/money';
import { openWalletWithBalance } from '@/domain/wallet/wallet-opening';
import { Wallet } from '@/domain/wallet/wallet';
import { WalletAlreadyExistsError, WalletNotFoundError } from '@/domain/wallet/wallet.errors';
import { hashCanonical } from '@/shared/hashing';
import {
  LedgerRepository,
  OutboxRepository,
  ReconciliationSnapshot,
  WagerTransactionRepository,
  WalletRepository,
} from '../ports/repositories';
import { Clock, IdGenerator, Logger } from '../ports/services';
import { Metrics } from '../ports/metrics';
import { UnitOfWork } from '../ports/transaction';
import { LedgerDirection } from '@/domain/ledger/wallet-ledger-entry';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

// ------------------------------------------------------------------------------ create

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletDeps {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  clock: Clock;
  ids: IdGenerator;
}

export class CreateWalletUseCase {
  constructor(private readonly deps: CreateWalletDeps) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const { uow, wallets, transactions, ledger, outbox, clock, ids } = this.deps;

    return uow.run(async (tx) => {
      const now = clock.now();
      const walletId = ids.next();
      const openingTransactionId = ids.next();
      const { wallet, opening } = openWalletWithBalance({
        walletId,
        playerId: command.playerId,
        initialBalance,
        now,
        openingTransactionId,
        openingEntryId: ids.next(),
        openingPayloadHash: hashCanonical({
          kind: 'OPENING',
          walletId,
          playerId: command.playerId,
          money: initialBalance.toJSON(),
        }),
      });

      // A unique (playerId, currency) violation is a conflict, never a second wallet.
      if (!(await wallets.insertIfAbsent(tx, wallet))) {
        throw new WalletAlreadyExistsError(command.playerId, wallet.currency);
      }

      if (opening) {
        // Same SQL transaction: wallet, OPENING transaction, CREDIT ledger entry and the event.
        await transactions.insertIfAbsent(tx, opening.transaction);
        await ledger.append(tx, opening.entry);
        await outbox.enqueue(
          tx,
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, opening.entry, {
              eventId: ids.next(),
              correlationId: command.correlationId,
              causationId: openingTransactionId,
              occurredAt: now,
            }),
          ),
        );
      }
      return toWalletView(wallet);
    });
  }
}

// ------------------------------------------------------------------------------ queries

export class GetWalletQuery {
  constructor(private readonly deps: { uow: UnitOfWork; wallets: WalletRepository }) {}

  async execute(walletId: string): Promise<WalletView> {
    return this.deps.uow.read(async (tx) => {
      const wallet = await this.deps.wallets.findById(tx, walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      return toWalletView(wallet);
    });
  }
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

/** Opaque cursor = base64url of the last walletVersion returned. Stable because versions never change. */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion }), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && 'v' in parsed) {
      const version = (parsed as { v: unknown }).v;
      if (typeof version === 'number' && Number.isInteger(version) && version >= 0) {
        return version;
      }
    }
  } catch {
    // fall through
  }
  return undefined;
}

export class GetLedgerQuery {
  constructor(
    private readonly deps: { uow: UnitOfWork; wallets: WalletRepository; ledger: LedgerRepository },
  ) {}

  async execute(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    const pageSize = Math.min(Math.max(limit, 1), MAX_LEDGER_LIMIT);
    return this.deps.uow.read(async (tx) => {
      if (!(await this.deps.wallets.exists(tx, walletId))) {
        throw new WalletNotFoundError(walletId);
      }
      const rows = await this.deps.ledger.list(tx, walletId, afterVersion, pageSize + 1);
      const page = rows.slice(0, pageSize);
      const last = page[page.length - 1];
      return {
        items: page.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: entry.walletVersion,
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: rows.length > pageSize && last ? encodeLedgerCursor(last.walletVersion) : null,
      };
    });
  }
}

// ------------------------------------------------------------------------------ reconciliation

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  /** Every ledger entry starts where the previous one ended. */
  ledgerChainIntact: boolean;
  checkedEntries: number;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      wallets: WalletRepository;
      metrics: Metrics;
      logger: Logger;
    },
  ) {}

  /**
   * Compares the materialized balance with the balance rebuilt from the ledger. It only reports:
   * a divergence is logged, counted and flagged, never silently "fixed".
   */
  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const snapshot: ReconciliationSnapshot | undefined = await this.deps.uow.read((tx) =>
      this.deps.wallets.reconciliationSnapshot(tx, walletId),
    );
    if (!snapshot) {
      throw new WalletNotFoundError(walletId);
    }

    const stored = Money.fromSigned({
      amount: snapshot.storedBalance,
      currency: snapshot.currency,
    });
    const calculated = Money.fromSigned({
      amount: snapshot.calculatedBalance,
      currency: snapshot.currency,
    });
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero() && snapshot.chainIntact;

    if (!consistent) {
      this.deps.metrics.reconciliationDivergence();
      this.deps.logger.error('wallet reconciliation divergence', {
        correlationId,
        walletId,
        chainIntact: snapshot.chainIntact,
        checkedEntries: snapshot.checkedEntries,
        differenceIsZero: difference.isZero(),
      });
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      ledgerChainIntact: snapshot.chainIntact,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
