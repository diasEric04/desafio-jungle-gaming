import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { WagerTransactionResult } from '@/application/dto';
import { WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '@/domain/wagering/wager-transaction';
import type { Container } from '@/infrastructure/container';
import { idempotencyKeySchema, wagerFieldsSchema } from '@/shared/wager-input-schema';
import { CONTAINER } from './tokens';
import { parseOrThrow } from './validation';

const uuid = z.string().uuid();
const providerParam = z.string().min(1).max(64);
const externalIdParam = z.string().min(1).max(128);

/**
 * Status of a submission:
 *   201 applied now | 200 replay of an applied one | 202 waiting for its reference
 *   422 rejected by a business rule (body carries failureCode + retryAdvice)
 */
export function httpStatusFor(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}

@Controller()
export class WageringController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() request: Request & { providerIdentity?: { providerId?: string } },
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = parseOrThrow(idempotencyKeySchema, idempotencyKey, 'Idempotency-Key header');
    const fields = parseOrThrow(wagerFieldsSchema, body, 'transaction');

    const scopedProvider = request.providerIdentity?.providerId;
    if (scopedProvider !== undefined && scopedProvider !== fields.providerId) {
      throw new ForbiddenException('caller is not allowed to act as this provider');
    }

    const result = await this.container.useCases.processWagerTransaction.execute({
      ...fields,
      kind: fields.kind as WagerTransactionKind,
      idempotencyKey: key,
      correlationId: String(request.headers['x-correlation-id'] ?? ''),
      source: 'http',
    });
    response.status(httpStatusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    return this.container.useCases.getTransaction.byId(
      parseOrThrow(uuid, transactionId, 'transactionId'),
    );
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProviderReference(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.container.useCases.getTransaction.byProviderReference(
      parseOrThrow(providerParam, providerId, 'providerId'),
      parseOrThrow(externalIdParam, externalTransactionId, 'externalTransactionId'),
    );
  }
}
