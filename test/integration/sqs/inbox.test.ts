import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  type MessageDelivery,
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../../src/application';
import { IdempotencyConflictError, InboxMessageConflictError } from '../../../src/domain';
import { expectConsistentWallets } from '../../support/consistency';
import { catchError, exec } from '../../support/database';
import {
  type CreatedWallet,
  createWallet,
  startTestApp,
  type TestApp,
  type WagerRequest,
  wagerBody,
} from '../../support/http-app';
import {
  inboxOf,
  ledgerOf,
  outboxByCorrelation,
  transactionsByKey,
  walletState,
} from '../../support/inspect';
import { holdWalletLock, waitForWalletLockWaiters } from '../../support/sync';

/**
 * Inbox `(consumerName, messageId)` no use case, contra o Postgres real: é gravada no mesmo COMMIT
 * de transação, saldo, ledger e outbox, e é ela (não a memória, nem a dedup do FIFO) que impede a
 * reentrega de repetir o efeito.
 *
 * O trigger temporário só dispara para mensagens `fault-commit-*` e, no COMMIT, confere que todo
 * o resto da operação já estava escrito na mesma transação (P0001) antes de derrubá-la.
 */
const FAULT_SQL = [
  /* sql */ `
create or replace function test_inbox_fault_on_commit() returns trigger language plpgsql as $$
begin
  if new.message_id like 'fault-commit-%' then
    if exists (
      select 1
        from wager_transactions t
        join wallet_ledger_entries l on l.transaction_id = t.id
        join wallets w on w.id = l.wallet_id
       where t.idempotency_key = 'provider-a:' || new.message_id
         and w.balance = l.balance_after and w.version = l.wallet_version
         and exists (select 1 from outbox_messages o
                      where o.payload -> 'data' ->> 'transactionId' = t.id::text)) then
      raise exception 'falha injetada no commit da inbox' using errcode = 'P0001';
    end if;
    raise exception 'falha injetada no commit da inbox, com escrita faltando' using errcode = 'P0002';
  end if;
  return null;
end $$`,
  'drop trigger if exists tg_test_inbox_fault_on_commit on inbox_messages',
  `create constraint trigger tg_test_inbox_fault_on_commit after insert on inbox_messages
     deferrable initially deferred for each row execute function test_inbox_fault_on_commit()`,
];

const CLEANUP_SQL = [
  'drop trigger if exists tg_test_inbox_fault_on_commit on inbox_messages',
  'drop function if exists test_inbox_fault_on_commit()',
];

const CONSUMER = `inbox-test-${randomUUID().slice(0, 8)}`;

describe('inbox do consumer no use case (Postgres real)', () => {
  let app: TestApp;
  let useCase: ProcessWagerTransaction;
  const wallets = new Set<string>();

  const open = async (initial: string): Promise<CreatedWallet> => {
    const wallet = await createWallet(app, initial);
    wallets.add(wallet.id);
    return wallet;
  };

  /** Comando como o consumer monta a partir da mensagem: correlação e causa = messageId. */
  const commandOf = (
    wallet: CreatedWallet,
    input: WagerRequest,
    messageId: string,
  ): ProcessWagerTransactionCommand => {
    const body = wagerBody(wallet, input);
    return {
      ...body,
      idempotencyKey: input.idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`,
      correlationId: messageId,
      causationId: messageId,
    } as unknown as ProcessWagerTransactionCommand;
  };

  const delivery = (messageId: string): MessageDelivery => ({
    consumerName: CONSUMER,
    messageId,
    messageType: 'WagerTransactionRequested',
    receivedAt: new Date(),
  });

  beforeAll(async () => {
    app = await startTestApp();
    useCase = app.get(ProcessWagerTransaction);
    for (const sql of FAULT_SQL) {
      await exec(app.orm, sql);
    }
  });

  afterEach(async () => {
    await expectConsistentWallets(app.orm, wallets);
    wallets.clear();
  });

  afterAll(async () => {
    for (const sql of CLEANUP_SQL) {
      await exec(app.orm, sql);
    }
    await app.close();
  });

  test('primeira entrega: efeito e inbox confirmados juntos', async () => {
    const wallet = await open('100.00');
    const messageId = `msg-${randomUUID()}`;
    const command = commandOf(wallet, { kind: 'BET', amount: '25.00' }, messageId);

    const outcome = await useCase.execute(command, delivery(messageId));
    expect(outcome).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(outcome.duplicateDelivery).toBeUndefined();

    const [inbox, ...others] = await inboxOf(app.orm, CONSUMER, [messageId]);
    expect(others).toEqual([]);
    expect(inbox).toMatchObject({ consumerName: CONSUMER, messageId });
    expect(inbox?.processedAt).not.toBeNull();
  });

  test('reentrega: devolve o resultado original e não grava nada de novo', async () => {
    const wallet = await open('100.00');
    const messageId = `msg-${randomUUID()}`;
    const command = commandOf(wallet, { kind: 'BET', amount: '25.00' }, messageId);
    const first = await useCase.execute(command, delivery(messageId));

    const again = await useCase.execute(command, delivery(messageId));
    expect(again).toEqual({ ...first, idempotentReplay: true, duplicateDelivery: true });
    expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(2);
    expect(await inboxOf(app.orm, CONSUMER, [messageId])).toHaveLength(1);
    expect(await outboxByCorrelation(app.orm, messageId)).toHaveLength(2);
    expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '75.00', version: 2 });
  });

  test('o mesmo messageId com outro conteúdo é conflito: nada é gravado', async () => {
    const wallet = await open('100.00');
    const messageId = `msg-${randomUUID()}`;
    await useCase.execute(
      commandOf(wallet, { kind: 'BET', amount: '25.00' }, messageId),
      delivery(messageId),
    );

    const other = commandOf(wallet, { kind: 'BET', amount: '30.00' }, messageId);
    expect(await catchError(() => useCase.execute(other, delivery(messageId)))).toBeInstanceOf(
      InboxMessageConflictError,
    );
    expect(await transactionsByKey(app.orm, other.idempotencyKey)).toHaveLength(0);
    expect(await walletState(app.orm, wallet.id)).toMatchObject({ balance: '75.00', version: 2 });
  });

  test('outra mensagem com a mesma operação: replay pela key e inbox das duas', async () => {
    const wallet = await open('100.00');
    const command = commandOf(wallet, { kind: 'BET', amount: '25.00' }, 'corr');
    const [m1, m2] = [`msg-${randomUUID()}`, `msg-${randomUUID()}`];
    const first = await useCase.execute(command, delivery(m1));
    const second = await useCase.execute(command, delivery(m2));

    expect(second).toEqual({ ...first, idempotentReplay: true });
    expect(await inboxOf(app.orm, CONSUMER, [m1, m2])).toHaveLength(2);
    expect(await transactionsByKey(app.orm, command.idempotencyKey)).toHaveLength(1);
  });

  test('REJECTED e PENDING_REFERENCE também gravam a inbox (desfecho confirmado)', async () => {
    const wallet = await open('10.00');
    const [m1, m2] = [`msg-${randomUUID()}`, `msg-${randomUUID()}`];
    const rejected = await useCase.execute(
      commandOf(wallet, { kind: 'BET', amount: '50.00' }, m1),
      delivery(m1),
    );
    const pending = await useCase.execute(
      commandOf(
        wallet,
        {
          kind: 'REFUND',
          amount: '5.00',
          referenceExternalTransactionId: `missing-${randomUUID()}`,
        },
        m2,
      ),
      delivery(m2),
    );
    expect(rejected).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(pending).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(await inboxOf(app.orm, CONSUMER, [m1, m2])).toHaveLength(2);
  });

  test('erro que faz rollback (conflito de idempotência) não deixa inbox', async () => {
    const wallet = await open('100.00');
    const key = `provider-a:${randomUUID()}`;
    const m1 = `msg-${randomUUID()}`;
    await useCase.execute(
      commandOf(wallet, { kind: 'BET', amount: '10.00', idempotencyKey: key }, m1),
      delivery(m1),
    );

    const m2 = `msg-${randomUUID()}`;
    const conflicting = commandOf(
      wallet,
      { kind: 'BET', amount: '20.00', idempotencyKey: key },
      m2,
    );
    expect(await catchError(() => useCase.execute(conflicting, delivery(m2)))).toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await inboxOf(app.orm, CONSUMER, [m2])).toEqual([]);
  });

  test('atomicidade: falha no COMMIT com transação, saldo, ledger, outbox e inbox escritos → nada fica', async () => {
    const wallet = await open('100.00');
    const messageId = `fault-commit-${randomUUID()}`;
    const command = commandOf(
      wallet,
      { kind: 'BET', amount: '25.00', externalTransactionId: messageId },
      messageId,
    );

    const error = (await catchError(() => useCase.execute(command, delivery(messageId)))) as {
      cause?: { code?: string };
      code?: string;
    };
    // P0001: no COMMIT a transação, o lançamento, o saldo e a outbox já estavam escritos
    expect(error.code ?? error.cause?.code).toBe('P0001');

    expect(await transactionsByKey(app.orm, command.idempotencyKey)).toHaveLength(0);
    expect(await inboxOf(app.orm, CONSUMER, [messageId])).toEqual([]);
    expect(await outboxByCorrelation(app.orm, messageId)).toEqual([]);
    expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(1);
    expect(await walletState(app.orm, wallet.id)).toEqual({
      balance: '100.00',
      currency: 'BRL',
      version: 1,
    });
  });

  test('a mesma entrega em paralelo (dois consumers): um efeito e uma linha de inbox', async () => {
    const wallet = await open('100.00');
    const messageId = `msg-${randomUUID()}`;
    const command = commandOf(wallet, { kind: 'BET', amount: '25.00' }, messageId);

    const lock = await holdWalletLock(app.orm, wallet.id);
    let results: Awaited<ReturnType<ProcessWagerTransaction['execute']>>[];
    try {
      const both = Promise.all([
        useCase.execute(command, delivery(messageId)),
        useCase.execute(command, delivery(messageId)),
      ]);
      // as duas passaram pela inbox e pela key sem achar nada e esperam a wallet
      await waitForWalletLockWaiters(app.orm, 'wagering-api', 2);
      await lock.release();
      results = await both;
    } finally {
      await lock.release();
    }

    // a segunda achou a transação da primeira, bateu na PK da inbox e virou reentrega
    const fresh = results.filter((r) => !r.idempotentReplay);
    const duplicates = results.filter((r) => r.duplicateDelivery);
    expect(fresh).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.transactionId).toBe(fresh[0]?.transactionId);
    expect(await inboxOf(app.orm, CONSUMER, [messageId])).toHaveLength(1);
    expect(await ledgerOf(app.orm, wallet.id)).toHaveLength(2);
  });
});
