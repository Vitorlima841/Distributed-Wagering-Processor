import { Migration } from '@mikro-orm/migrations';

/**
 * Fase 7 (outbox publisher e worker de PENDING_REFERENCE), ARCHITECTURE §19.
 *
 * 1. `wager_transactions.correlation_id`: o correlationId da requisição (HTTP) ou da mensagem (SQS)
 *    que criou a transação. O worker de PENDING_REFERENCE emite eventos muito depois da
 *    requisição; com a coluna, esses eventos levam a correlação original. Não entra no
 *    `payload_hash` (é metadado de transporte) e não muda depois de gravado. Formato: até 128
 *    caracteres ASCII visíveis (o do `X-Correlation-Id` ou, pela fila, o `messageId`). É anulável só por
 *    causa das linhas anteriores a esta migration; o código sempre preenche.
 * 2. Guarda da outbox: o envelope é imutável, `attempts` não diminui, uma mensagem publicada não
 *    muda mais e uma mensagem pendente não pode ser apagada (seria um evento confirmado perdido).
 *    Apagar mensagens já publicadas continua possível (retenção).
 */

const CORRELATION = [
  'alter table wager_transactions add column correlation_id text',
  /* sql */ `alter table wager_transactions add constraint ck_wager_tx_correlation_id
    check (correlation_id is null or correlation_id ~ '^[!-~]{1,128}$')`,
  /* sql */ `
create function wager_transactions_guard_correlation() returns trigger language plpgsql as $$
begin
  if new.correlation_id is distinct from old.correlation_id then
    raise exception 'transação %: correlation_id é imutável', old.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  return new;
end $$`,
  /* sql */ `create trigger tg_wager_tx_guard_correlation before update of correlation_id
    on wager_transactions for each row execute function wager_transactions_guard_correlation()`,
];

const OUTBOX_GUARD = [
  /* sql */ `
create function outbox_guard_update() returns trigger language plpgsql as $$
begin
  if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
     is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
    raise exception 'outbox %: o envelope do evento é imutável', old.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  if old.published_at is not null then
    raise exception 'outbox %: mensagem já publicada não muda', old.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  if new.attempts < old.attempts then
    raise exception 'outbox %: attempts não pode diminuir', old.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  return new;
end $$`,
  /* sql */ `create trigger tg_outbox_guard_update before update on outbox_messages
    for each row execute function outbox_guard_update()`,
  /* sql */ `
create function outbox_forbid_pending_delete() returns trigger language plpgsql as $$
begin
  raise exception 'outbox %: mensagem não publicada não pode ser apagada', old.id
    using errcode = 'integrity_constraint_violation', constraint = tg_name;
end $$`,
  /* sql */ `create trigger tg_outbox_no_pending_delete before delete on outbox_messages
    for each row when (old.published_at is null) execute function outbox_forbid_pending_delete()`,
];

const DOWN = [
  'drop trigger if exists tg_outbox_no_pending_delete on outbox_messages',
  'drop function if exists outbox_forbid_pending_delete()',
  'drop trigger if exists tg_outbox_guard_update on outbox_messages',
  'drop function if exists outbox_guard_update()',
  'drop trigger if exists tg_wager_tx_guard_correlation on wager_transactions',
  'drop function if exists wager_transactions_guard_correlation()',
  'alter table wager_transactions drop constraint if exists ck_wager_tx_correlation_id',
  'alter table wager_transactions drop column if exists correlation_id',
];

export class Migration20261106180000OutboxAndPendingReference extends Migration {
  override async up(): Promise<void> {
    for (const sql of [...CORRELATION, ...OUTBOX_GUARD]) {
      this.addSql(sql);
    }
  }

  override async down(): Promise<void> {
    for (const sql of DOWN) {
      this.addSql(sql);
    }
  }
}
