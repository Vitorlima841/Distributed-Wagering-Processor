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
  classifyError,
  GetWagerTransaction,
  ProcessWagerTransaction,
  type WagerTransactionView,
} from '../../application';
import { addLogContext } from '../../infrastructure/logging/log-context';
import { METRICS, type WageringMetrics } from '../../infrastructure/observability/metrics';
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
    @Inject(METRICS) private readonly metrics: WageringMetrics,
  ) {}

  /**
   * O status depende do resultado (201/200/202/422), então a resposta é enviada aqui: o Nest
   * sobrescreveria um `res.status()` com o código fixo da rota. Exceções seguem para o filtro.
   * Ids e status entram no contexto de log da requisição; valores em dinheiro, nunca.
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @CorrelationId() correlationId: string,
    @Res() response: HttpResponse,
  ): Promise<void> {
    const startedAt = performance.now();
    const elapsed = () => (performance.now() - startedAt) / 1000;
    try {
      const key = parseIdempotencyKey(idempotencyKey);
      const input = parseRequest(submitWagerSchema, body);
      addLogContext({ walletId: input.walletId, providerId: input.providerId, kind: input.kind });
      const outcome = await this.processWager.execute({
        ...input,
        referenceExternalTransactionId: input.referenceExternalTransactionId ?? undefined,
        idempotencyKey: key,
        correlationId,
      });
      addLogContext({
        transactionId: outcome.transactionId,
        status: outcome.status,
        idempotentReplay: outcome.idempotentReplay,
      });
      this.metrics.recordOutcome('http', input.kind, outcome, elapsed());
      response.status(httpStatusForOutcome(outcome)).json(outcome);
    } catch (error) {
      this.metrics.recordFailure('http', classifyError(error), elapsed());
      throw error;
    }
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
