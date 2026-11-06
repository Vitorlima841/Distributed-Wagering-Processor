import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  classifyError,
  type PendingReferenceRetryOutcome,
  RetryPendingReferences,
} from '../../../src/application';
import { FailureCode } from '../../../src/domain';
import { buildOrmConfig } from '../../../src/infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/database/mikro-orm-unit-of-work';
import { UuidV7Generator } from '../../../src/infrastructure/system';
import { ManualClock } from '../../support/clock';
import { expectConsistentWallets } from '../../support/consistency';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../support/database';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  submitWager,
  type TestApp,
  type WagerRequest,
} from '../../support/http-app';
import {
  ledgerOf,
  outboxOfTransaction,
  transactionState,
  walletState,
} from '../../support/inspect';
import { holdWalletLock, waitUntil } from '../../support/sync';

/**
 * Worker de PENDING_REFERENCE em processo, com relógio controlado (o backoff de ~5 min roda sem
 * sleeps), contra Postgres real num banco isolado (o worker lê a tabela inteira). As transações
 * chegam pela API HTTP real, ligada ao mesmo banco.
 */

const TIMEOUT_MS = 30_000;
const SECOND = 1_000;

describe('worker de PENDING_REFERENCE (Postgres real)', () => {
  let db: IsolatedDatabase;
  /** Segundo pool: outra "instância" do worker. */
  let otherOrm: MikroORM;
  let app: TestApp;
  const clock = new ManualClock();
  const ids = new UuidV7Generator();
  const wallets = new Set<string>();

  const workerOn = (orm: MikroORM, { lockTimeoutMs = 5_000 } = {}) =>
    new RetryPendingReferences(new MikroOrmUnitOfWork(orm, { lockTimeoutMs }), clock, ids, {
      batchSize: 100,
      maxAttempts: 10,
    });
  let worker: RetryPendingReferences;

  const open = async (initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(app, initial);
    wallets.add(wallet.id);
    return wallet;
  };

  /** Envia e guarda o corpo/key para repetir a mesma requisição depois (replay). */
  const send = async (wallet: CreatedWallet, input: WagerRequest) => {
    const externalTransactionId = input.externalTransactionId ?? `ext-${randomUUID()}`;
    const request = { ...input, externalTransactionId };
    const res = await submitWager(app, wallet, request);
    return { res, replay: () => submitWager(app, wallet, request) };
  };

  const nextAttemptOf = async (transactionId: string): Promise<Date> => {
    const { nextAttemptAt } = await transactionState(db.orm, transactionId);
    if (nextAttemptAt === null) {
      throw new Error(`transação ${transactionId} sem próxima tentativa`);
    }
    return new Date(nextAttemptAt);
  };

  /** Um ciclo do worker; devolve o desfecho da transação de interesse (se ela foi candidata). */
  const cycle = async (
    transactionId: string,
    target = worker,
  ): Promise<PendingReferenceRetryOutcome | undefined> => {
    const summary = await target.runOnce();
    expect(summary.errors).toEqual([]);
    return summary.results.find((result) => result.transactionId === transactionId);
  };

  /** Leva o relógio até a próxima tentativa (1 ms antes ela ainda não vence) e roda um ciclo. */
  const attemptWhenDue = async (transactionId: string) => {
    const due = await nextAttemptOf(transactionId);
    clock.set(new Date(due.getTime() - 1));
    expect(await cycle(transactionId)).toBeUndefined();
    clock.set(due);
    return cycle(transactionId);
  };

  beforeAll(async () => {
    db = await createIsolatedDatabase();
    otherOrm = await MikroORM.init(buildOrmConfig(db.url));
    app = await startTestApp({ DATABASE_URL: db.url });
    worker = workerOn(db.orm);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await expectConsistentWallets(db.orm, wallets);
    await app.close();
    await otherOrm.close(true);
    await db.drop();
  }, TIMEOUT_MS);

  test(
    'REFUND antes da BET: 202; a BET chega; o worker credita com a correlação original',
    async () => {
      const wallet = await open('100.00');
      const betExternalId = `bet-${randomUUID()}`;
      const refund = await send(wallet, {
        kind: 'REFUND',
        amount: '25.00',
        referenceExternalTransactionId: betExternalId,
        correlationId: 'corr-refund-1',
      });
      expect(refund.res.status).toBe(202);
      expect(refund.res.body).toMatchObject({
        status: 'PENDING_REFERENCE',
        balance: { amount: '100.00' },
      });
      const refundId: string = refund.res.body.transactionId;

      const bet = await send(wallet, {
        kind: 'BET',
        amount: '25.00',
        externalTransactionId: betExternalId,
      });
      expect(bet.res.status).toBe(201);
      expect(bet.res.body.balance.amount).toBe('75.00');

      const outcome = await attemptWhenDue(refundId);
      expect(outcome).toEqual({ transactionId: refundId, outcome: 'PROCESSED' });

      const state = await transactionState(db.orm, refundId);
      expect(state).toMatchObject({
        status: 'PROCESSED',
        referenceTransactionId: bet.res.body.transactionId,
        balanceAfter: '100.00',
        nextAttemptAt: null,
        referenceAttempts: 0,
      });
      expect(await walletState(db.orm, wallet.id)).toMatchObject({ balance: '100.00', version: 3 });
      const ledger = await ledgerOf(db.orm, wallet.id);
      expect(ledger.at(-1)).toMatchObject({
        transactionId: refundId,
        direction: 'CREDIT',
        amount: '25.00',
        balanceBefore: '75.00',
        balanceAfter: '100.00',
      });

      // eventos: o da chegada e os da resolução, todos com a correlação da requisição original
      const events = await outboxOfTransaction(db.orm, refundId);
      expect(events.map((e) => e.eventType)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      expect(events.every((e) => e.payload.correlationId === 'corr-refund-1')).toBe(true);
      const processed = events.find((e) => e.eventType === 'WagerTransactionProcessed');
      expect(processed?.payload.occurredAt).toBe(clock.now().toISOString());

      // o replay devolve o estado atual (resolvido), e a consulta também
      const replay = await refund.replay();
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({
        transactionId: refundId,
        status: 'PROCESSED',
        balance: { amount: '100.00' },
        idempotentReplay: true,
      });
      const query = await app.request('GET', `/wagering/transactions/${refundId}`);
      expect(query.body.status).toBe('PROCESSED');
    },
    TIMEOUT_MS,
  );

  test(
    'ROLLBACK de um WIN que chega depois: o worker debita o inverso',
    async () => {
      const wallet = await open('50.00');
      const winExternalId = `win-${randomUUID()}`;
      const rollback = await send(wallet, {
        kind: 'ROLLBACK',
        amount: '30.00',
        referenceExternalTransactionId: winExternalId,
      });
      expect(rollback.res.status).toBe(202);
      const rollbackId: string = rollback.res.body.transactionId;

      const win = await send(wallet, {
        kind: 'WIN',
        amount: '30.00',
        externalTransactionId: winExternalId,
      });
      expect(win.res.body.balance.amount).toBe('80.00');

      expect(await attemptWhenDue(rollbackId)).toEqual({
        transactionId: rollbackId,
        outcome: 'PROCESSED',
      });
      expect((await walletState(db.orm, wallet.id)).balance).toBe('50.00');
      expect((await ledgerOf(db.orm, wallet.id)).at(-1)).toMatchObject({
        transactionId: rollbackId,
        direction: 'DEBIT',
        amount: '30.00',
        balanceAfter: '50.00',
      });
    },
    TIMEOUT_MS,
  );

  test(
    'a referência chega, mas não bate: o worker aplica as mesmas regras (AMOUNT_MISMATCH)',
    async () => {
      const wallet = await open('100.00');
      const betExternalId = `bet-${randomUUID()}`;
      const refund = await send(wallet, {
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: betExternalId,
      });
      const refundId: string = refund.res.body.transactionId;
      await send(wallet, { kind: 'BET', amount: '20.00', externalTransactionId: betExternalId });

      expect(await attemptWhenDue(refundId)).toEqual({
        transactionId: refundId,
        outcome: 'REJECTED',
        failureCode: FailureCode.AmountMismatch,
      });
      expect((await walletState(db.orm, wallet.id)).balance).toBe('80.00');
      expect((await outboxOfTransaction(db.orm, refundId)).map((e) => e.eventType)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
      const replay = await refund.replay();
      expect(replay.status).toBe(422);
      expect(replay.body).toMatchObject({ status: 'REJECTED', failureCode: 'AMOUNT_MISMATCH' });
    },
    TIMEOUT_MS,
  );

  test(
    'sem referência: 10 tentativas com backoff 1s, 2s, 4s… (teto 60s), depois REJECTED / REFERENCE_NOT_FOUND',
    async () => {
      const wallet = await open('100.00');
      const betExternalId = `bet-${randomUUID()}`;
      const refund = await send(wallet, {
        kind: 'REFUND',
        amount: '15.00',
        referenceExternalTransactionId: betExternalId,
        correlationId: 'corr-lost-ref',
      });
      const refundId: string = refund.res.body.transactionId;
      const firstDue = await nextAttemptOf(refundId);

      const gaps: number[] = [];
      for (let attempt = 1; attempt <= 9; attempt += 1) {
        const outcome = await attemptWhenDue(refundId);
        expect(outcome).toMatchObject({ outcome: 'PENDING_REFERENCE', attempts: attempt });
        const state = await transactionState(db.orm, refundId);
        expect(state).toMatchObject({ status: 'PENDING_REFERENCE', referenceAttempts: attempt });
        gaps.push(((await nextAttemptOf(refundId)).getTime() - clock.now().getTime()) / SECOND);
      }
      expect(gaps).toEqual([2, 4, 8, 16, 32, 60, 60, 60, 60]);

      const last = await attemptWhenDue(refundId);
      expect(last).toEqual({
        transactionId: refundId,
        outcome: 'REJECTED',
        failureCode: FailureCode.ReferenceNotFound,
      });
      // 2 + 4 + 8 + 16 + 32 + 60 × 4 = 302 s depois da 1ª tentativa, que vence 1 s após a chegada:
      // a rejeição sai 303 s (≈ 5 min) depois da chegada
      expect((clock.now().getTime() - firstDue.getTime()) / SECOND).toBe(302);

      expect(await transactionState(db.orm, refundId)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
        referenceAttempts: 10,
        nextAttemptAt: null,
        balanceAfter: '100.00',
      });
      // as tentativas sem sucesso não repetem o evento; o esgotamento emite o Rejected
      const events = await outboxOfTransaction(db.orm, refundId);
      expect(events.map((e) => e.eventType)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
      const rejected = events.find((e) => e.eventType === 'WagerTransactionRejected');
      expect(rejected?.payload).toMatchObject({
        correlationId: 'corr-lost-ref',
        data: { failureCode: 'REFERENCE_NOT_FOUND', providerAction: 'fix_payload' },
      });

      const replay = await refund.replay();
      expect(replay.status).toBe(422);
      expect(replay.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });

      // consequência documentada (ARCHITECTURE §19): a BET que chega depois é processada, e a
      // reversão rejeitada não volta; o provedor reenvia com outro id
      const lateBet = await send(wallet, {
        kind: 'BET',
        amount: '15.00',
        externalTransactionId: betExternalId,
      });
      expect(lateBet.res.status).toBe(201);
      clock.advance(10 * 60 * SECOND);
      expect(await cycle(refundId)).toBeUndefined();
      expect((await transactionState(db.orm, refundId)).status).toBe('REJECTED');
    },
    TIMEOUT_MS,
  );

  test(
    'dois workers e a API na mesma wallet: a tentativa conta uma vez e não há deadlock',
    async () => {
      const wallet = await open('100.00');
      const betExternalId = `bet-${randomUUID()}`;
      const refund = await send(wallet, {
        kind: 'REFUND',
        amount: '5.00',
        referenceExternalTransactionId: betExternalId,
      });
      const refundId: string = refund.res.body.transactionId;
      clock.set(await nextAttemptOf(refundId));
      const candidate = { transactionId: refundId, walletId: wallet.id };

      // o teste trava a wallet; os dois workers e uma BET pela API ficam esperando o mesmo lock
      const lock = await holdWalletLock(db.orm, wallet.id);
      const workerA = workerOn(db.orm).retry(candidate);
      const workerB = workerOn(otherOrm).retry(candidate);
      const bet = submitWager(app, wallet, { kind: 'BET', amount: '1.00' });
      await waitUntil('3 esperando o lock da wallet', async () => {
        const [row] = await db.orm.em.fork().execute<{ n: number }[]>(
          `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query ilike '%from "wallets"%for update%'`,
        );
        return row?.n === 3;
      });
      await lock.release();

      const outcomes = (await Promise.all([workerA, workerB])).map((r) => r.outcome).sort();
      expect(outcomes).toEqual(['PENDING_REFERENCE', 'SKIPPED']);
      expect((await bet).status).toBe(201);
      expect((await transactionState(db.orm, refundId)).referenceAttempts).toBe(1);

      // a referência chega e o próximo ciclo resolve
      await send(wallet, { kind: 'BET', amount: '5.00', externalTransactionId: betExternalId });
      expect(await attemptWhenDue(refundId)).toEqual({
        transactionId: refundId,
        outcome: 'PROCESSED',
      });
      expect((await walletState(db.orm, wallet.id)).balance).toBe('99.00');
    },
    TIMEOUT_MS,
  );

  test(
    'lock timeout: o ciclo registra erro transitório sem gravar nada; o seguinte aplica',
    async () => {
      const wallet = await open('100.00');
      const refund = await send(wallet, {
        kind: 'REFUND',
        amount: '5.00',
        referenceExternalTransactionId: `bet-${randomUUID()}`,
      });
      const refundId: string = refund.res.body.transactionId;
      clock.set(await nextAttemptOf(refundId));
      const impatient = workerOn(db.orm, { lockTimeoutMs: 200 });

      const lock = await holdWalletLock(db.orm, wallet.id);
      let summary: Awaited<ReturnType<RetryPendingReferences['runOnce']>>;
      try {
        summary = await impatient.runOnce();
      } finally {
        await lock.release();
      }
      const failure = summary.errors.find((e) => e.transactionId === refundId);
      expect(classifyError(failure?.error).code).toBe('LOCK_TIMEOUT');
      expect(await transactionState(db.orm, refundId)).toMatchObject({
        status: 'PENDING_REFERENCE',
        referenceAttempts: 0,
      });

      expect(await cycle(refundId, impatient)).toMatchObject({
        outcome: 'PENDING_REFERENCE',
        attempts: 1,
      });
    },
    TIMEOUT_MS,
  );
});
