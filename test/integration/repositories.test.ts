import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  FailureCode,
  InboxMessage,
  WagerTransactionKind as Kind,
  LedgerDirection,
  OutboxMessage,
  WagerTransactionStatus as Status,
  WalletBalanceChanged,
} from '../../src/domain';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { createTestOrm, expectBalanceMatchesLedger } from '../support/database';
import {
  type OpenedWallet,
  openWalletViaDomain,
  processWager,
  retryPendingReference,
} from '../support/domain-flows';

describe('repositórios MikroORM (Postgres real)', () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;
  const wallets = new Set<string>();

  const open = async (initial: string): Promise<OpenedWallet> => {
    const opened = await openWalletViaDomain(uow, initial);
    wallets.add(opened.walletId);
    return opened;
  };

  beforeAll(async () => {
    orm = await createTestOrm();
    uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 5_000 });
  });

  afterEach(async () => {
    await expectBalanceMatchesLedger(orm, wallets);
    wallets.clear();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  describe('wallet', () => {
    test('ida e volta via rehydrate: saldo exato, version e moeda', async () => {
      const { walletId, playerId } = await open('1000.00');
      const loaded = await uow.run((s) => s.wallets.findById(walletId));
      expect(loaded?.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
      expect(loaded?.version).toBe(1);
      expect(loaded?.playerId).toBe(playerId);
      expect(loaded?.createdAt).toBeInstanceOf(Date);

      const byPlayer = await uow.run((s) => s.wallets.findByPlayerAndCurrency(playerId, 'BRL'));
      expect(byPlayer?.id).toBe(walletId);
      expect(
        await uow.run((s) => s.wallets.findByPlayerAndCurrency(playerId, 'USD')),
      ).toBeUndefined();
    });

    test('limite de numeric(20,2) volta exato (sem passar por number)', async () => {
      const { walletId } = await open('999999999999999999.99');
      const loaded = await uow.run((s) => s.wallets.findById(walletId));
      expect(loaded?.balance.toJSON().amount).toBe('999999999999999999.99');
    });

    test('wallet com saldo zero não tem abertura nem lançamento', async () => {
      const { walletId } = await open('0.00');
      const loaded = await uow.run((s) => s.wallets.findById(walletId));
      expect(loaded?.balance.toJSON().amount).toBe('0.00');
      expect(
        await uow.run((s) => s.transactions.findByIdempotencyKey(`opening:${walletId}`)),
      ).toBeUndefined();
    });
  });

  describe('transações e ledger', () => {
    test('abertura: OPENING PROCESSED e CREDIT de 0.00 até o saldo, versão 1', async () => {
      const { walletId, openingTransactionId } = await open('250.00');
      const opening = await uow.run((s) =>
        s.transactions.findByIdempotencyKey(`opening:${walletId}`),
      );
      expect(opening?.id).toBe(openingTransactionId);
      expect(opening?.kind).toBe(Kind.Opening);
      expect(opening?.status).toBe(Status.Processed);
      expect(opening?.balanceAfter?.toJSON().amount).toBe('250.00');

      const entry = await uow.run((s) => s.ledger.findByTransactionId(openingTransactionId));
      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(entry?.balanceBefore.toJSON().amount).toBe('0.00');
      expect(entry?.balanceAfter.toJSON().amount).toBe('250.00');
      expect(entry?.walletVersion).toBe(1);
      expect(entry?.isBalanced()).toBe(true);
    });

    test('BET PROCESSED: wallet, transação e lançamento gravados juntos', async () => {
      const wallet = await open('100.00');
      const { transaction } = await processWager(uow, wallet, { kind: Kind.Bet, amount: '80.00' });

      const loaded = await uow.run((s) =>
        s.transactions.findByProviderAndExternalId('provider-a', transaction.externalTransactionId),
      );
      expect(loaded?.status).toBe(Status.Processed);
      expect(loaded?.payloadHash).toBe(transaction.payloadHash);
      expect(loaded?.balanceAfter?.toJSON().amount).toBe('20.00');
      expect(loaded?.processedAt?.getTime()).toBe(transaction.processedAt?.getTime());
      expect(loaded?.matchesPayload(transaction.payloadHash)).toBe(true);

      const walletAfter = await uow.run((s) => s.wallets.findById(wallet.walletId));
      expect(walletAfter?.balance.toJSON().amount).toBe('20.00');
      expect(walletAfter?.version).toBe(2);

      const entry = await uow.run((s) => s.ledger.findByTransactionId(transaction.id));
      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(entry?.walletVersion).toBe(2);
    });

    test('BET REJECTED: transação auditável, sem lançamento e sem mexer na wallet', async () => {
      const wallet = await open('10.00');
      const { transaction, result } = await processWager(uow, wallet, {
        kind: Kind.Bet,
        amount: '80.00',
      });
      expect(result).toEqual({ outcome: 'REJECTED', failureCode: FailureCode.InsufficientFunds });

      const loaded = await uow.run((s) => s.transactions.findById(transaction.id));
      expect(loaded?.status).toBe(Status.Rejected);
      expect(loaded?.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(loaded?.balanceAfter?.toJSON().amount).toBe('10.00');
      expect(await uow.run((s) => s.ledger.findByTransactionId(transaction.id))).toBeUndefined();
      expect((await uow.run((s) => s.wallets.findById(wallet.walletId)))?.version).toBe(1);
    });

    test('LOSS PROCESSED com 0.00: sem lançamento, version não muda', async () => {
      const wallet = await open('10.00');
      const { transaction } = await processWager(uow, wallet, { kind: Kind.Loss, amount: '0.00' });
      const loaded = await uow.run((s) => s.transactions.findById(transaction.id));
      expect(loaded?.status).toBe(Status.Processed);
      expect(loaded?.money.toJSON().amount).toBe('0.00');
      expect((await uow.run((s) => s.wallets.findById(wallet.walletId)))?.version).toBe(1);
    });

    test('REFUND da BET aparece em findProcessedReversalsOf; ROLLBACK depois é ALREADY_REVERSED', async () => {
      const wallet = await open('100.00');
      const bet = await processWager(uow, wallet, { kind: Kind.Bet, amount: '30.00' });
      const refund = await processWager(uow, wallet, {
        kind: Kind.Refund,
        amount: '30.00',
        referenceExternalTransactionId: bet.transaction.externalTransactionId,
      });
      expect(refund.result.outcome).toBe('PROCESSED');

      const reversals = await uow.run((s) =>
        s.transactions.findProcessedReversalsOf(bet.transaction.id),
      );
      expect(reversals.map((r) => r.id)).toEqual([refund.transaction.id]);
      expect(reversals[0]?.referenceTransactionId).toBe(bet.transaction.id);

      const rollback = await processWager(uow, wallet, {
        kind: Kind.Rollback,
        amount: '30.00',
        referenceExternalTransactionId: bet.transaction.externalTransactionId,
      });
      expect(rollback.result).toEqual({
        outcome: 'REJECTED',
        failureCode: FailureCode.AlreadyReversed,
      });
      expect(
        (await uow.run((s) => s.wallets.findById(wallet.walletId)))?.balance.toJSON().amount,
      ).toBe('100.00');
    });

    test('REFUND antes da BET: PENDING_REFERENCE, depois o reprocessamento aplica', async () => {
      const wallet = await open('100.00');
      const betId = `bet-${randomUUID()}`;
      const refund = await processWager(uow, wallet, {
        kind: Kind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: betId,
      });
      expect(refund.result.outcome).toBe('PENDING_REFERENCE');

      const pending = await uow.run((s) => s.transactions.findById(refund.transaction.id));
      expect(pending?.status).toBe(Status.PendingReference);
      expect(pending?.nextAttemptAt).toBeInstanceOf(Date);
      expect(pending?.referenceAttempts).toBe(0);

      await processWager(uow, wallet, {
        kind: Kind.Bet,
        amount: '25.00',
        externalTransactionId: betId,
      });

      // UPDATE da transação + INSERT do lançamento + UPDATE da wallet na mesma UnitOfWork:
      // os triggers diferidos aceitam porque checam no COMMIT, não na ordem dos comandos
      const result = await retryPendingReference(uow, wallet, refund.transaction.id);
      expect(result.outcome).toBe('PROCESSED');

      const applied = await uow.run((s) => s.transactions.findById(refund.transaction.id));
      expect(applied?.status).toBe(Status.Processed);
      expect(applied?.nextAttemptAt).toBeUndefined();
      expect(applied?.referenceTransactionId).toBeDefined();
      const walletAfter = await uow.run((s) => s.wallets.findById(wallet.walletId));
      expect(walletAfter?.balance.toJSON().amount).toBe('100.00');
      expect(walletAfter?.version).toBe(3);
    });

    test('reprocessamento sem referência agenda nova tentativa (sem lançamento)', async () => {
      const wallet = await open('100.00');
      const refund = await processWager(uow, wallet, {
        kind: Kind.Refund,
        amount: '5.00',
        referenceExternalTransactionId: `bet-${randomUUID()}`,
      });
      const result = await retryPendingReference(uow, wallet, refund.transaction.id);
      expect(result.outcome).toBe('PENDING_REFERENCE');
      const loaded = await uow.run((s) => s.transactions.findById(refund.transaction.id));
      expect(loaded?.referenceAttempts).toBe(1);
      expect(loaded?.status).toBe(Status.PendingReference);
    });
  });

  describe('inbox e outbox', () => {
    test('inbox: grava, encontra e marca como processada', async () => {
      const messageId = `msg-${randomUUID()}`;
      const receivedAt = new Date();
      await uow.run((s) =>
        s.inbox.add(
          InboxMessage.receive({
            messageId,
            consumerName: 'wager-consumer',
            payloadHash: 'b'.repeat(64),
            receivedAt,
          }),
        ),
      );
      await uow.run(async (s) => {
        const message = await s.inbox.find('wager-consumer', messageId);
        expect(message?.isProcessed()).toBe(false);
        message?.markProcessed(new Date(receivedAt.getTime() + 10));
        if (message) {
          await s.inbox.save(message);
        }
      });
      const reloaded = await uow.run((s) => s.inbox.find('wager-consumer', messageId));
      expect(reloaded?.isProcessed()).toBe(true);
      expect(reloaded?.receivedAt.getTime()).toBe(receivedAt.getTime());
    });

    test('outbox: payload jsonb volta igual ao envelope do evento (dinheiro como string)', async () => {
      const wallet = await open('100.00');
      const { transaction } = await processWager(uow, wallet, { kind: Kind.Win, amount: '12.34' });
      const [loadedWallet, entry] = await uow.run(async (s) => [
        await s.wallets.findById(wallet.walletId),
        await s.ledger.findByTransactionId(transaction.id),
      ]);
      if (!loadedWallet || !entry) {
        throw new Error('wallet ou lançamento ausente');
      }
      const event = WalletBalanceChanged.from(loadedWallet, entry, {
        eventId: randomUUID(),
        correlationId: 'corr-1',
        occurredAt: new Date(),
      });
      await uow.run((s) => s.outbox.add(OutboxMessage.enqueue(event)));

      const stored = await uow.run((s) => s.outbox.findById(event.eventId));
      expect(stored?.payload).toEqual(JSON.parse(JSON.stringify(event.toJSON())));
      expect(stored?.eventType).toBe('WalletBalanceChanged');
      expect(stored?.isDue(new Date())).toBe(true);
      const data = stored?.payload.data as { money: unknown } | undefined;
      expect(data?.money).toEqual({
        amount: '12.34',
        currency: 'BRL',
      });
    });
  });
});
