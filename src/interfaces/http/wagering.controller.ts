import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  GetWagerTransaction,
  ProcessWagerTransaction,
  type WagerTransactionView,
} from '../../application';
import { CorrelationId } from './correlation';
import { httpStatusForOutcome } from './http-status';
import type { HttpResponse } from './http-types';
import { ProviderAuthGuard } from './provider-auth.guard';
import { parseIdempotencyKey, parseRequest, submitWagerSchema } from './request-validation';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(GetWagerTransaction) private readonly getTransaction: GetWagerTransaction,
  ) {}

  /**
   * O status depende do resultado (201/200/202/422), então a resposta é enviada aqui: o Nest
   * sobrescreveria um `res.status()` com o código fixo da rota. Exceções seguem para o filtro.
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @CorrelationId() correlationId: string,
    @Res() response: HttpResponse,
  ): Promise<void> {
    const key = parseIdempotencyKey(idempotencyKey);
    const input = parseRequest(submitWagerSchema, body);
    const outcome = await this.processWager.execute({
      ...input,
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? undefined,
      idempotencyKey: key,
      correlationId,
    });
    response.status(httpStatusForOutcome(outcome)).json(outcome);
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string): Promise<WagerTransactionView> {
    return this.getTransaction.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.getTransaction.byProviderAndExternalId(providerId, externalTransactionId);
  }
}
