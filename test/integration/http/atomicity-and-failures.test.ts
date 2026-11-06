import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../../src/application';
import {
  catchError,
  exec,
  expectBalanceMatchesLedger,
  inTransaction,
} from '../../support/database';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  submitRaw,
  type TestApp,
  wagerBody,
} from '../../support/http-app';
import {
  ledgerOf,
  outboxByCorrelation,
  transactionsByKey,
  walletState,
} from '../../support/inspect';
import { gate } from '../../support/sync';

/**
 * Falhas reais no Postgres no meio da transação financeira. Os triggers temporários só disparam
 * para operações marcadas (externalTransactionId `fault-flush-*`, correlationId `fault-commit-*`),
 * então não interferem em nenhum outro teste. O SQLSTATE diz o que já estava gravado quando a
 * falha aconteceu: P0001 = o esperado, P0002 = algo faltava (o teste então falha).
 *
 * No flush, o MikroORM envia o INSERT da outbox antes do de `wager_transactions`: a falha no
 * INSERT da transação acontece com os eventos já gravados na sessão.
 */
const FAULT_SQL = [
  /* sql */ `
create or replace function test_fault_on_flush() returns trigger language plpgsql as $$
begin
  if new.external_transaction_id like 'fault-flush-%' then
    if exists (select 1 from outbox_messages
                where payload -> 'data' ->> 'transactionId' = new.id::text) then
      raise exception 'falha injetada no flush' using errcode = 'P0001';
    end if;
    raise exception 'falha injetada no flush, sem escrita anterior' using errcode = 'P0002';
  end if;
  return new;
end $$`,
  'drop trigger if exists tg_test_fault_on_flush on wager_transactions',
  `create trigger tg_test_fault_on_flush before insert on wager_transactions
     for each row execute function test_fault_on_flush()`,
  /* sql */ `
create or replace function test_fault_on_commit() returns trigger language plpgsql as $$
declare
  tx_id uuid := (new.payload -> 'data' ->> 'transactionId')::uuid;
begin
  if new.payload ->> 'correlationId' like 'fault-commit-%' then
    -- no COMMIT tudo já foi executado: transação, lançamento e UPDATE do saldo da wallet
    if exists (select 1 from wallet_ledger_entries l join wallets w on w.id = l.wallet_id
                where l.transaction_id = tx_id and w.balance = l.balance_after
                  and w.version = l.wallet_version) then
      raise exception 'falha injetada no commit' using errcode = 'P0001';
    end if;
    raise exception 'falha injetada no commit, com escrita faltando' using errcode = 'P0002';
  end if;
  return null;
end $$`,
  'drop trigger if exists tg_test_fault_on_commit on outbox_messages',
  `create constraint trigger tg_test_fault_on_commit after insert on outbox_messages
     deferrable initially deferred for each row execute function test_fault_on_commit()`,
];

const CLEANUP_SQL = [
  'drop trigger if exists tg_test_fault_on_flush on wager_transactions',
  'drop trigger if exists tg_test_fault_on_commit on outbox_messages',
  'drop function if exists test_fault_on_flush()',
  'drop function if exists test_fault_on_commit()',
];

/** Mesmo payload do HTTP, entregue direto ao use case (como o consumer SQS fará). */
const commandOf = (
  body: Record<string, unknown>,
  idempotencyKey: string,
  correlationId: string,
): ProcessWagerTransactionCommand =>
  ({ ...body, idempotencyKey, correlationId }) as unknown as ProcessWagerTransactionCommand;

describe('atomicidade e falhas de infraestrutura (HTTP + Postgres real)', () => {
  let app: TestApp;
  /** Mesmo app, com lock_timeout curto para provocar o 503. */
  let slowLockApp: TestApp;
  const wallets = new Set<string>();

  const open = async (target: TestApp, initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(target, initial);
    wallets.add(wallet.id);
    return wallet;
  };

  /** Nada da tentativa ficou: saldo, version, ledger, transação e outbox como antes. */
  const expectNothingWritten = async (
    wallet: CreatedWallet,
    key: string,
    correlationId: string,
  ) => {
    expect(await walletState(app.orm, wallet.id)).toEqual({
      balance: '100.00',
      currency: 'BRL',
      version: 1,
    });
    expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(1);
    expect(await transactionsByKey(app.orm, key)).toHaveLength(0);
    expect(await outboxByCorrelation(app.orm, correlationId)).toHaveLength(0);
  };

  beforeAll(async () => {
    app = await startTestApp();
    slowLockApp = await startTestApp({ DB_LOCK_TIMEOUT_MS: '300' });
    for (const sql of FAULT_SQL) {
      await exec(app.orm, sql);
    }
  });

  afterEach(async () => {
    await expectBalanceMatchesLedger(app.orm, wallets);
    wallets.clear();
  });

  afterAll(async () => {
    for (const sql of CLEANUP_SQL) {
      await exec(app.orm, sql);
    }
    await slowLockApp.close();
    await app.close();
  });

  describe('falha no meio → nada gravado', () => {
    const faultyBet = (wallet: CreatedWallet) =>
      wagerBody(wallet, {
        kind: 'BET',
        amount: '25.00',
        externalTransactionId: `fault-flush-${randomUUID()}`,
      });

    test('no flush, com eventos já gravados na sessão: rollback de tudo e 500 genérico', async () => {
      const wallet = await open(app, '100.00');
      const body = faultyBet(wallet);
      const key = `provider-a:${body.externalTransactionId}`;
      const correlationId = `corr-${randomUUID()}`;

      const res = await submitRaw(app, body, key, correlationId);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          category: 'internal',
          message: 'Erro interno inesperado',
          retryable: false,
        },
        correlationId,
      });
      await expectNothingWritten(wallet, key, correlationId);
    });

    test('no flush (via use case): a falha aconteceu depois de outra escrita da mesma operação', async () => {
      const wallet = await open(app, '100.00');
      const body = faultyBet(wallet);
      const key = `provider-a:${body.externalTransactionId}`;
      const correlationId = `corr-${randomUUID()}`;
      const error = (await catchError(() =>
        app.get(ProcessWagerTransaction).execute(commandOf(body, key, correlationId)),
      )) as { code?: string };
      expect(error.code).toBe('P0001');
      await expectNothingWritten(wallet, key, correlationId);
    });

    test('no COMMIT, depois de transação, lançamento e saldo: rollback de tudo', async () => {
      const wallet = await open(app, '100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '25.00' });
      const key = `provider-a:${body.externalTransactionId}`;
      const correlationId = `fault-commit-${randomUUID()}`;
      const error = (await catchError(() =>
        app.get(ProcessWagerTransaction).execute(commandOf(body, key, correlationId)),
      )) as { code?: string };
      expect(error.code).toBe('P0001');
      await expectNothingWritten(wallet, key, correlationId);

      // a mesma requisição, sem a falha, processa normalmente (nada ficou "meio gravado")
      const retry = await submitRaw(app, body, key);
      expect(retry.status).toBe(201);
      expect(retry.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    });
  });

  describe('falha transitória → 503', () => {
    test('wallet travada além do lock_timeout → 503 LOCK_TIMEOUT com Retry-After; repetir depois dá 201', async () => {
      const wallet = await open(slowLockApp, '100.00');
      const body = wagerBody(wallet, { kind: 'BET', amount: '10.00' });
      const key = `provider-a:${body.externalTransactionId}`;
      const correlationId = `lock-${randomUUID()}`;
      const locked = gate();
      const release = gate();
      const holder = inTransaction(app.orm, async (em) => {
        await em.execute('select id from wallets where id = ? for update', [wallet.id]);
        locked.open();
        await release.promise;
      });
      await locked.promise;

      const res = await submitRaw(slowLockApp, body, key, correlationId);
      release.open();
      await holder;

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(res.body.error).toMatchObject({
        code: 'LOCK_TIMEOUT',
        category: 'transient',
        retryable: true,
      });
      await expectNothingWritten(wallet, key, correlationId);

      const retry = await submitRaw(slowLockApp, body, key);
      expect(retry.status).toBe(201);
      expect(retry.body.idempotentReplay).toBe(false);
    });
  });
});
