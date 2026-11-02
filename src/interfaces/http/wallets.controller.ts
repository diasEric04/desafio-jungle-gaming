import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  decodeLedgerCursor,
  DEFAULT_LEDGER_LIMIT,
  MAX_LEDGER_LIMIT,
} from '@/application/use-cases/wallets';
import type { Container } from '@/infrastructure/container';
import { moneySchema } from '@/shared/wager-input-schema';
import { CONTAINER } from './tokens';
import { parseOrThrow, RequestValidationError } from './validation';

const createWalletSchema = z
  .object({ playerId: z.string().uuid(), initialBalance: moneySchema })
  .strict();
const walletIdSchema = z.string().uuid();
const limitSchema = z.coerce.number().int().min(1).max(MAX_LEDGER_LIMIT);

const correlationId = (request: Request) => String(request.headers['x-correlation-id'] ?? '');

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Post()
  async create(@Body() body: unknown, @Req() request: Request) {
    const input = parseOrThrow(createWalletSchema, body, 'wallet');
    return this.container.useCases.createWallet.execute({
      ...input,
      correlationId: correlationId(request),
    });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return this.container.useCases.getWallet.execute(
      parseOrThrow(walletIdSchema, walletId, 'walletId'),
    );
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const id = parseOrThrow(walletIdSchema, walletId, 'walletId');
    const pageSize =
      limit === undefined ? DEFAULT_LEDGER_LIMIT : parseOrThrow(limitSchema, limit, 'limit');
    let after = 0;
    if (cursor !== undefined) {
      const decoded = decodeLedgerCursor(cursor);
      if (decoded === undefined) throw new RequestValidationError('invalid cursor');
      after = decoded;
    }
    return this.container.useCases.getLedger.execute(id, after, pageSize);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string, @Req() request: Request) {
    return this.container.useCases.reconcileWallet.execute(
      parseOrThrow(walletIdSchema, walletId, 'walletId'),
      correlationId(request),
    );
  }
}
