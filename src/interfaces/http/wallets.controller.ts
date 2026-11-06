import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateWallet,
  GetWallet,
  type LedgerPageView,
  ListWalletLedger,
  ReconcileWallet,
  type ReconciliationReport,
  type WalletView,
} from '../../application';
import { CorrelationId } from './correlation';
import { ProviderAuthGuard } from './provider-auth.guard';
import { createWalletSchema, parseCursor, parseLimit, parseRequest } from './request-validation';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(ListWalletLedger) private readonly listLedger: ListWalletLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @CorrelationId() correlationId: string): Promise<WalletView> {
    const input = parseRequest(createWalletSchema, body);
    return this.createWallet.execute({ ...input, correlationId });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<LedgerPageView> {
    return this.listLedger.execute({
      walletId,
      cursor: parseCursor(cursor),
      limit: parseLimit(limit),
    });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletId);
  }
}
