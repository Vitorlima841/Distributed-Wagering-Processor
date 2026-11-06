import { Global, Module } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  CreateWallet,
  GetWagerTransaction,
  GetWallet,
  ID_GENERATOR,
  type IdGenerator,
  ListWalletLedger,
  ProcessWagerTransaction,
  RECONCILIATION_MONITOR,
  RECONCILIATION_READER,
  ReconcileWallet,
  type ReconciliationMonitor,
  type ReconciliationReader,
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../application';

/**
 * Liga os use cases (classes puras da `application`, sem decorators) aos ports por token.
 * Global: HTTP, consumer SQS (fase 6) e workers (fase 7) usam as mesmas instâncias.
 */
@Global()
@Module({
  providers: [
    {
      provide: ProcessWagerTransaction,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new ProcessWagerTransaction(uow, clock, ids),
    },
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new CreateWallet(uow, clock, ids),
    },
    {
      provide: GetWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWallet(uow),
    },
    {
      provide: ListWalletLedger,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new ListWalletLedger(uow),
    },
    {
      provide: GetWagerTransaction,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWagerTransaction(uow),
    },
    {
      provide: ReconcileWallet,
      inject: [RECONCILIATION_READER, RECONCILIATION_MONITOR],
      useFactory: (reader: ReconciliationReader, monitor: ReconciliationMonitor) =>
        new ReconcileWallet(reader, monitor),
    },
  ],
  exports: [
    ProcessWagerTransaction,
    CreateWallet,
    GetWallet,
    ListWalletLedger,
    GetWagerTransaction,
    ReconcileWallet,
  ],
})
export class UseCasesModule {}
