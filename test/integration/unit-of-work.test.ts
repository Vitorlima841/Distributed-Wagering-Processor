import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  IntegrityViolationError,
  RepositoryMisuseError,
  type TransactionScope,
  TransientPersistenceError,
  UniqueViolationError,
} from '../../src/application/ports';
import {
  InsufficientFundsError,
  WagerTransactionKind as Kind,
  LedgerDirection,
  WagerTransactionStatus as Status,
  WagerTransaction,
  Wallet,
  WalletLedgerEntry,
} from '../../src/domain';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import {
  catchError,
  createTestOrm,
  expectBalanceMatchesLedger,
  inTransaction,
} from '../support/database';
import { brl, type OpenedWallet, openWalletViaDomain, processWager } from '../support/domain-flows';

/** Promessa controlada de fora: sincroniza transações concorrentes sem sleeps. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('MikroOrmUnitOfWork (Postgres real)', () => {
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

  describe('atomicidade', () => {
    test('erro de domínio no meio: rollback, nada gravado, erro original propagado', async () => {
      const walletId = randomUUID();
      const failure = new InsufficientFundsError('1.00 BRL', '0.00 BRL');
      const error = await catchError(() =>
        uow.run(async (s) => {
          const { wallet } = Wallet.open({
            id: walletId,
            playerId: randomUUID(),
            initialBalance: brl('0.00'),
            openingTransactionId: randomUUID(),
            openingEntryId: randomUUID(),
            now: new Date(),
          });
          await s.wallets.add(wallet);
          throw failure;
        }),
      );
      expect(error).toBe(failure);
      expect(await uow.run((s) => s.wallets.findById(walletId))).toBeUndefined();
    });

    test('falha no COMMIT (trigger diferido): rollback de tudo e IntegrityViolationError', async () => {
      const wallet = await open('100.00');
      const error = await catchError(() =>
        uow.run(async (s) => {
          const { transaction } = await processWagerInScope(s, wallet);
          // lançamento forjado via rehydrate (sem validação): saldo antes errado
          await s.ledger.append(
            WalletLedgerEntry.rehydrate({
              id: randomUUID(),
              walletId: wallet.walletId,
              transactionId: transaction,
              direction: LedgerDirection.Credit,
              money: brl('10.00'),
              balanceBefore: brl('50.00'),
              balanceAfter: brl('60.00'),
              walletVersion: 2,
              createdAt: new Date(),
            }),
          );
        }),
      );
      expect(error).toBeInstanceOf(IntegrityViolationError);
      expect((error as IntegrityViolationError).category).toBe('invariant');
      expect((error as IntegrityViolationError).constraint).toMatch(/^tg_/);
      const walletAfter = await uow.run((s) => s.wallets.findById(wallet.walletId));
      expect(walletAfter?.balance.toJSON().amount).toBe('100.00');
      expect(walletAfter?.version).toBe(1);
    });
  });

  describe('tradução de erros do banco', () => {
    test('wallet duplicada vira UniqueViolationError com o nome da constraint', async () => {
      const first = await open('0.00');
      const error = await catchError(() =>
        openWalletViaDomain(uow, '0.00', { playerId: first.playerId }),
      );
      expect(error).toBeInstanceOf(UniqueViolationError);
      expect((error as UniqueViolationError).constraint).toBe('ux_wallets_player_currency');
      expect((error as UniqueViolationError).category).toBe('conflict');
    });

    test('idempotency key repetida vira UniqueViolationError', async () => {
      const wallet = await open('100.00');
      const externalTransactionId = `ext-${randomUUID()}`;
      await processWager(uow, wallet, { kind: Kind.Loss, amount: '0.00', externalTransactionId });
      const error = await catchError(() =>
        processWager(uow, wallet, { kind: Kind.Loss, amount: '0.00', externalTransactionId }),
      );
      expect(error).toBeInstanceOf(UniqueViolationError);
      expect((error as UniqueViolationError).constraint).toBe('ux_wager_tx_idempotency_key');
    });
  });

  describe('lock pessimista da wallet', () => {
    test('findByIdForUpdate segura a linha até o fim da transação', async () => {
      const wallet = await open('100.00');
      const locked = gate();
      const release = gate();
      const holder = uow.run(async (s) => {
        await s.wallets.findByIdForUpdate(wallet.walletId);
        locked.open();
        await release.promise;
      });
      await locked.promise;

      const error = await catchError(() =>
        inTransaction(orm, (em) =>
          em.execute('select id from wallets where id = ? for update nowait', [wallet.walletId]),
        ),
      );
      expect((error as { code?: string }).code).toBe('55P03');

      release.open();
      await holder;
      // solto o lock, outra transação consegue travar
      await inTransaction(orm, (em) =>
        em.execute('select id from wallets where id = ? for update nowait', [wallet.walletId]),
      );
    });

    test('espera maior que lock_timeout vira TransientPersistenceError (lock_timeout)', async () => {
      const wallet = await open('100.00');
      const impatient = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 100 });
      const locked = gate();
      const release = gate();
      const holder = uow.run(async (s) => {
        await s.wallets.findByIdForUpdate(wallet.walletId);
        locked.open();
        await release.promise;
      });
      await locked.promise;

      const error = await catchError(() =>
        impatient.run((s) => s.wallets.findByIdForUpdate(wallet.walletId)),
      );
      release.open();
      await holder;
      expect(error).toBeInstanceOf(TransientPersistenceError);
      expect((error as TransientPersistenceError).reason).toBe('lock_timeout');
    });

    test('save sem lock é recusado (read → calculate → update proibido)', async () => {
      const wallet = await open('100.00');
      const error = await catchError(() =>
        uow.run(async (s) => {
          const loaded = await s.wallets.findById(wallet.walletId);
          if (loaded) {
            await s.wallets.save(loaded);
          }
        }),
      );
      expect(error).toBeInstanceOf(RepositoryMisuseError);
    });

    test('duas BET de 80.00 simultâneas sobre 100.00: uma PROCESSED, outra REJECTED, saldo 20.00', async () => {
      const wallet = await open('100.00');
      const results = await Promise.all([
        processWager(uow, wallet, { kind: Kind.Bet, amount: '80.00' }),
        processWager(uow, wallet, { kind: Kind.Bet, amount: '80.00' }),
      ]);
      expect(results.map((r) => r.transaction.status).sort()).toEqual([
        Status.Processed,
        Status.Rejected,
      ]);
      const walletAfter = await uow.run((s) => s.wallets.findById(wallet.walletId));
      expect(walletAfter?.balance.toJSON().amount).toBe('20.00');
      const [debits] = await orm.em
        .fork()
        .execute<{ count: string }[]>(
          `select count(*)::text as count from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
          [wallet.walletId],
        );
      expect(debits?.count).toBe('1');
    });
  });

  test('lockTimeoutMs precisa ser inteiro positivo', () => {
    expect(() => new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 0 })).toThrow();
    expect(() => new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 1.5 })).toThrow();
  });
});

/** WIN aplicado à wallet dentro de uma UnitOfWork já aberta (sem o lançamento); devolve o id. */
async function processWagerInScope(
  s: TransactionScope,
  wallet: OpenedWallet,
): Promise<{ transaction: string }> {
  const loaded = await s.wallets.findByIdForUpdate(wallet.walletId);
  if (!loaded) {
    throw new Error('wallet ausente');
  }
  const now = new Date();
  const tx = WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    idempotencyKey: `provider-a:${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Win,
    money: brl('10.00'),
    now,
  });
  loaded.credit({ money: brl('10.00'), transactionId: tx.id, entryId: randomUUID(), now });
  tx.markProcessed(undefined, loaded.balance, now);
  await s.transactions.add(tx);
  await s.wallets.save(loaded);
  return { transaction: tx.id };
}
