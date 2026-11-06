import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  createTestOrm,
  exec,
  expectBalanceMatchesLedger,
  expectViolation,
  SQLSTATE,
} from '../../support/database';
import { wageringFixture } from '../../support/wagering-fixture';

/**
 * Garantias da migration da fase 7 aplicadas no schema (SQL puro): guarda da outbox e
 * `wager_transactions.correlation_id` imutável e com formato válido.
 */
describe('constraints da fase 7 (SQL puro contra o Postgres real)', () => {
  let orm: MikroORM;
  const wallets = new Set<string>();

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await expectBalanceMatchesLedger(orm, wallets);
    await orm.close(true);
  });

  /** Mensagem de outbox válida e pendente; devolve o id. */
  const insertOutbox = async (): Promise<string> => {
    const id = randomUUID();
    const aggregateId = randomUUID();
    await exec(
      orm,
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       values (?, ?, 'WagerTransactionProcessed', ?::jsonb, now(), 0, now())`,
      [
        id,
        aggregateId,
        JSON.stringify({
          eventId: id,
          eventType: 'WagerTransactionProcessed',
          aggregateId,
          correlationId: 'c',
          occurredAt: new Date().toISOString(),
          version: 1,
          data: {},
        }),
      ],
    );
    return id;
  };

  const guard = { constraint: 'tg_outbox_guard_update', code: SQLSTATE.trigger };

  describe('outbox', () => {
    test('o envelope é imutável', async () => {
      const id = await insertOutbox();
      await expectViolation(
        () =>
          exec(orm, `update outbox_messages set payload = payload || '{"x":1}' where id = ?`, [id]),
        guard,
      );
      await expectViolation(
        () => exec(orm, `update outbox_messages set event_type = 'Other' where id = ?`, [id]),
        guard,
      );
    });

    test('attempts não diminui; retry agendado é aceito', async () => {
      const id = await insertOutbox();
      await exec(
        orm,
        `update outbox_messages set attempts = 1, next_attempt_at = now() + interval '1 second' where id = ?`,
        [id],
      );
      await expectViolation(
        () => exec(orm, 'update outbox_messages set attempts = 0 where id = ?', [id]),
        guard,
      );
    });

    test('mensagem publicada não muda mais; pode ser apagada (retenção)', async () => {
      const id = await insertOutbox();
      await exec(orm, 'update outbox_messages set published_at = now() where id = ?', [id]);
      await expectViolation(
        () => exec(orm, 'update outbox_messages set published_at = null where id = ?', [id]),
        guard,
      );
      await expectViolation(
        () => exec(orm, 'update outbox_messages set attempts = attempts + 1 where id = ?', [id]),
        guard,
      );
      await exec(orm, 'delete from outbox_messages where id = ?', [id]);
    });

    test('mensagem pendente não pode ser apagada (seria um evento confirmado perdido)', async () => {
      const id = await insertOutbox();
      await expectViolation(() => exec(orm, 'delete from outbox_messages where id = ?', [id]), {
        constraint: 'tg_outbox_no_pending_delete',
        code: SQLSTATE.trigger,
      });
    });
  });

  describe('correlation_id da transação', () => {
    test('gravado pelo use case e imutável', async () => {
      const fixture = wageringFixture(orm);
      const wallet = await fixture.openWallet('10.00');
      wallets.add(wallet.walletId);
      const refund = await fixture.wager(wallet, {
        kind: 'REFUND',
        amount: '1.00',
        referenceExternalTransactionId: `bet-${randomUUID()}`,
        correlationId: 'corr-original',
      });
      const [row] = await orm.em
        .fork()
        .execute<{ correlationId: string }[]>(
          'select correlation_id as "correlationId" from wager_transactions where id = ?',
          [refund.transactionId],
        );
      expect(row?.correlationId).toBe('corr-original');

      // a transação ainda está aberta (PENDING_REFERENCE): só a guarda da correlação barra
      await expectViolation(
        () =>
          exec(orm, `update wager_transactions set correlation_id = 'other' where id = ?`, [
            refund.transactionId,
          ]),
        { constraint: 'tg_wager_tx_guard_correlation', code: SQLSTATE.trigger },
      );
    });

    test('formato: até 128 caracteres ASCII visíveis', async () => {
      const fixture = wageringFixture(orm);
      const wallet = await fixture.openWallet('10.00');
      wallets.add(wallet.walletId);
      const loss = await fixture.wager(wallet, { kind: 'LOSS', amount: '0.00' });
      // cópia da LOSS com outra key e correlação inválida
      const copy = (correlation: string) =>
        exec(
          orm,
          `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key,
             payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
             balance_after, balance_after_currency, reference_attempts, created_at, processed_at,
             correlation_id)
           select ?, provider_id, external_transaction_id || '-copy', idempotency_key || '-copy',
             payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
             balance_after, balance_after_currency, 0, created_at, processed_at, ?
             from wager_transactions where id = ?`,
          [randomUUID(), correlation, loss.transactionId],
        );
      for (const invalid of ['tem espaço', '', 'x'.repeat(129), 'acentuação']) {
        await expectViolation(() => copy(invalid), {
          constraint: 'ck_wager_tx_correlation_id',
          code: SQLSTATE.check,
        });
      }
    });
  });
});
