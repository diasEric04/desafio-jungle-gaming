import { TransactionNotFoundError } from '@/domain/wagering/wagering.errors';
import { toView, WagerTransactionView } from '../dto';
import { WagerTransactionRepository } from '../ports/repositories';
import { UnitOfWork } from '../ports/transaction';

export class GetWagerTransactionQuery {
  constructor(
    private readonly deps: { uow: UnitOfWork; transactions: WagerTransactionRepository },
  ) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    return this.deps.uow.read(async (tx) => {
      const transaction = await this.deps.transactions.findById(tx, transactionId);
      if (!transaction) {
        throw new TransactionNotFoundError(transactionId);
      }
      return toView(transaction);
    });
  }

  async byProviderReference(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.deps.uow.read(async (tx) => {
      const transaction = await this.deps.transactions.findByProviderAndExternalId(
        tx,
        providerId,
        externalTransactionId,
      );
      if (!transaction) {
        throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
      }
      return toView(transaction);
    });
  }
}
