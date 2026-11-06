import { Migration } from '@mikro-orm/migrations';

/**
 * Schema do processador de apostas. As garantias de unicidade, imutabilidade e não-negatividade
 * vivem aqui (restrição 9), não só no código. Convenção de nomes: pk_, ux_ (único), fk_, ck_ (CHECK),
 * ix_ (índice), tg_ (trigger). O UnitOfWork traduz erros pelo nome da constraint.
 *
 * Erros dos triggers usam SQLSTATE 23000 (integrity_constraint_violation) e CONSTRAINT = nome do trigger.
 *
 * FKs são DEFERRABLE INITIALLY DEFERRED: o flush do MikroORM faz todos os INSERTs antes dos UPDATEs e
 * só ordena tabelas por relações declaradas (os records são planos), então a checagem fica no COMMIT.
 */

const WALLETS = /* sql */ `
create table wallets (
  id          uuid          not null,
  player_id   uuid          not null,
  currency    char(3)       not null,
  balance     numeric(20,2) not null,
  version     integer       not null,
  created_at  timestamptz   not null,
  updated_at  timestamptz   not null,
  constraint pk_wallets primary key (id),
  constraint ux_wallets_player_currency unique (player_id, currency),
  -- alvo da FK (wallet_id, currency) do ledger: moeda do lançamento = moeda da wallet
  constraint ux_wallets_id_currency unique (id, currency),
  constraint ck_wallets_currency check (currency ~ '^[A-Z]{3}$'),
  constraint ck_wallets_balance_non_negative check (balance >= 0),
  constraint ck_wallets_version_positive check (version >= 1)
)`;

const WAGER_TRANSACTIONS = /* sql */ `
create table wager_transactions (
  id                                uuid          not null,
  provider_id                       text          not null,
  external_transaction_id           text          not null,
  idempotency_key                   text          not null,
  payload_hash                      char(64)      not null,
  wallet_id                         uuid          not null,
  player_id                         uuid          not null,
  round_id                          text          not null,
  game_id                           text          not null,
  kind                              text          not null,
  amount                            numeric(20,2) not null,
  currency                          char(3)       not null,
  reference_external_transaction_id text,
  reference_transaction_id          uuid,
  status                            text          not null,
  failure_code                      text,
  -- snapshot do saldo observado (replay). É da wallet, cuja moeda pode diferir (CURRENCY_MISMATCH).
  balance_after                     numeric(20,2),
  balance_after_currency            char(3),
  reference_attempts                integer       not null default 0,
  next_attempt_at                   timestamptz,
  created_at                        timestamptz   not null,
  processed_at                      timestamptz,

  constraint pk_wager_transactions primary key (id),
  constraint ux_wager_tx_idempotency_key unique (idempotency_key),
  constraint ux_wager_tx_provider_external unique (provider_id, external_transaction_id),
  -- alvo das FKs compostas (referência e ledger na mesma wallet)
  constraint ux_wager_tx_id_wallet unique (id, wallet_id),

  constraint fk_wager_tx_wallet foreign key (wallet_id)
    references wallets (id) deferrable initially deferred,
  -- a referência resolvida aponta para uma transação da MESMA wallet
  constraint fk_wager_tx_reference_same_wallet foreign key (reference_transaction_id, wallet_id)
    references wager_transactions (id, wallet_id) deferrable initially deferred,

  constraint ck_wager_tx_kind check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  constraint ck_wager_tx_status check (
    status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  constraint ck_wager_tx_failure_code check (failure_code in (
    'INSUFFICIENT_FUNDS','REVERSAL_INSUFFICIENT_FUNDS','REFERENCE_NOT_FOUND','REFERENCE_MISMATCH',
    'REFERENCE_INVALID_KIND','REFERENCE_NOT_PROCESSED','ALREADY_REVERSED','AMOUNT_MISMATCH',
    'CURRENCY_MISMATCH','WALLET_PLAYER_MISMATCH','INFRA_PERMANENT_ERROR')),
  constraint ck_wager_tx_payload_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_wager_tx_currency check (currency ~ '^[A-Z]{3}$'),
  constraint ck_wager_tx_text_not_blank check (
    btrim(provider_id) <> '' and btrim(external_transaction_id) <> '' and btrim(idempotency_key) <> ''
    and btrim(round_id) <> '' and btrim(game_id) <> ''
    and (reference_external_transaction_id is null or btrim(reference_external_transaction_id) <> '')),

  -- valor positivo, exceto LOSS (aceita 0.00)
  constraint ck_wager_tx_amount check (amount > 0 or (kind = 'LOSS' and amount = 0)),

  -- OPENING é interno; a key opening:{walletId} é única, logo há no máximo uma abertura por wallet
  constraint ck_wager_tx_opening check ((kind = 'OPENING') = (provider_id = 'internal')),
  constraint ck_wager_tx_opening_shape check (kind <> 'OPENING' or (
    idempotency_key = 'opening:' || wallet_id::text
    and external_transaction_id = idempotency_key
    and status = 'PROCESSED')),

  -- referências
  constraint ck_wager_tx_reference_required check (
    kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
  constraint ck_wager_tx_reference_forbidden check (
    kind not in ('BET','OPENING') or reference_external_transaction_id is null),
  -- toda reversão PROCESSED tem referência resolvida, e só ela tem. Sem isso, um NULL escaparia
  -- de ux_wager_tx_reversal_once (NULLs não colidem em índice único).
  constraint ck_wager_tx_resolved_reference check (
    (reference_transaction_id is not null) = (kind in ('REFUND','ROLLBACK') and status = 'PROCESSED')),
  constraint ck_wager_tx_no_self_reference check (reference_transaction_id <> id),

  -- máquina de estados
  constraint ck_wager_tx_failure_iff_unsuccessful check (
    (status in ('REJECTED','FAILED')) = (failure_code is not null)),
  constraint ck_wager_tx_failed_is_infra check (
    failure_code is null or (status = 'FAILED') = (failure_code = 'INFRA_PERMANENT_ERROR')),
  constraint ck_wager_tx_terminal_processed_at check (
    (status in ('PROCESSED','REJECTED','FAILED')) = (processed_at is not null)),
  constraint ck_wager_tx_pending_reference check (
    (status = 'PENDING_REFERENCE') = (next_attempt_at is not null)
    and (status <> 'PENDING_REFERENCE' or kind in ('REFUND','ROLLBACK'))),
  constraint ck_wager_tx_reference_attempts check (reference_attempts >= 0),
  constraint ck_wager_tx_snapshot check (status in ('PENDING','FAILED') or balance_after is not null),
  constraint ck_wager_tx_snapshot_currency check (
    (balance_after is null) = (balance_after_currency is null)),
  constraint ck_wager_tx_snapshot_non_negative check (balance_after >= 0)
)`;

const WAGER_TRANSACTIONS_INDEXES = [
  // uma reversão PROCESSED por referência, de qualquer tipo (ARCHITECTURE §14.1)
  /* sql */ `create unique index ux_wager_tx_reversal_once on wager_transactions (reference_transaction_id)
    where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`,
  // worker de PENDING_REFERENCE: candidatos vencidos
  /* sql */ `create index ix_wager_tx_pending_reference_due on wager_transactions (next_attempt_at)
    where status = 'PENDING_REFERENCE'`,
];

const LEDGER = /* sql */ `
create table wallet_ledger_entries (
  id             uuid          not null,
  -- ordem global de inserção; por wallet é estável porque o lock da wallet serializa os inserts
  seq            bigint        generated always as identity,
  wallet_id      uuid          not null,
  transaction_id uuid          not null,
  direction      text          not null,
  amount         numeric(20,2) not null,
  currency       char(3)       not null,
  balance_before numeric(20,2) not null,
  balance_after  numeric(20,2) not null,
  -- versão da wallet depois do lançamento: encadeia o ledger de cada wallet
  wallet_version integer       not null,
  created_at     timestamptz   not null,
  constraint pk_wallet_ledger_entries primary key (id),
  constraint ux_ledger_wallet_seq unique (wallet_id, seq),
  -- dois lançamentos com a mesma versão da wallet = lost update
  constraint ux_ledger_wallet_version unique (wallet_id, wallet_version),
  -- com fk_ledger_transaction_wallet, equivale a "no máximo um lançamento por wallet" (e é mais forte)
  constraint ux_ledger_transaction unique (transaction_id),
  constraint fk_ledger_wallet_currency foreign key (wallet_id, currency)
    references wallets (id, currency) deferrable initially deferred,
  constraint fk_ledger_transaction_wallet foreign key (transaction_id, wallet_id)
    references wager_transactions (id, wallet_id) deferrable initially deferred,
  constraint ck_ledger_direction check (direction in ('DEBIT','CREDIT')),
  constraint ck_ledger_amount_positive check (amount > 0),
  constraint ck_ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
  constraint ck_ledger_arithmetic check (
       (direction = 'CREDIT' and balance_after = balance_before + amount)
    or (direction = 'DEBIT'  and balance_after = balance_before - amount)),
  constraint ck_ledger_wallet_version check (wallet_version >= 1)
)`;

const INBOX = /* sql */ `
create table inbox_messages (
  consumer_name text        not null,
  message_id    text        not null,
  payload_hash  char(64)    not null,
  received_at   timestamptz not null,
  processed_at  timestamptz,
  constraint pk_inbox_messages primary key (consumer_name, message_id),
  constraint ck_inbox_not_blank check (btrim(consumer_name) <> '' and btrim(message_id) <> ''),
  constraint ck_inbox_payload_hash check (payload_hash ~ '^[0-9a-f]{64}$')
)`;

const OUTBOX = /* sql */ `
create table outbox_messages (
  id              uuid        not null,
  aggregate_id    uuid        not null,
  event_type      text        not null,
  payload         jsonb       not null,
  occurred_at     timestamptz not null,
  attempts        integer     not null default 0,
  next_attempt_at timestamptz not null,
  published_at    timestamptz,
  constraint pk_outbox_messages primary key (id),
  constraint ck_outbox_attempts check (attempts >= 0),
  -- as colunas batem com o envelope gravado (id = eventId, que o consumidor usa para deduplicar)
  constraint ck_outbox_envelope check (
    jsonb_typeof(payload) = 'object'
    and payload ->> 'eventId' = id::text
    and payload ->> 'eventType' = event_type
    and payload ->> 'aggregateId' = aggregate_id::text)
)`;

const OUTBOX_INDEXES = [
  /* sql */ `create index ix_outbox_due on outbox_messages (next_attempt_at) where published_at is null`,
];

/** Ledger append-only; wager_transactions sem DELETE/TRUNCATE (transação rejeitada também é auditoria). */
const FORBID_MUTATION = [
  /* sql */ `
create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% em % não é permitido', tg_op, tg_table_name
    using errcode = 'integrity_constraint_violation', constraint = tg_name;
end $$`,
  /* sql */ `create trigger tg_ledger_append_only before update or delete on wallet_ledger_entries
    for each row execute function forbid_mutation()`,
  /* sql */ `create trigger tg_ledger_no_truncate before truncate on wallet_ledger_entries
    for each statement execute function forbid_mutation()`,
  /* sql */ `create trigger tg_wager_tx_no_delete before delete on wager_transactions
    for each row execute function forbid_mutation()`,
  /* sql */ `create trigger tg_wager_tx_no_truncate before truncate on wager_transactions
    for each statement execute function forbid_mutation()`,
];

const WALLETS_GUARD = [
  /* sql */ `
create function wallets_guard_update() returns trigger language plpgsql as $$
begin
  if (new.id, new.player_id, new.currency, new.created_at)
     is distinct from (old.id, old.player_id, old.currency, old.created_at) then
    raise exception 'wallet %: id, player_id, currency e created_at são imutáveis', old.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  -- version sobe exatamente 1 quando o saldo muda e não muda caso contrário. Em READ COMMITTED,
  -- OLD é a última versão confirmada: um UPDATE calculado sobre leitura velha (lost update) falha aqui.
  if new.version <> old.version + (case when new.balance <> old.balance then 1 else 0 end) then
    raise exception 'wallet %: version % -> % inválida para saldo % -> %',
      old.id, old.version, new.version, old.balance, new.balance
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  return new;
end $$`,
  /* sql */ `create trigger tg_wallets_guard_update before update on wallets
    for each row execute function wallets_guard_update()`,
];

const WAGER_TRANSACTIONS_GUARD = [
  /* sql */ `
create function wager_transactions_guard_update() returns trigger language plpgsql as $$
begin
  if old.status in ('PROCESSED','REJECTED','FAILED') then
    raise exception 'transação % em estado terminal (%) não muda', old.id, old.status
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  if old.status = 'PENDING_REFERENCE' and new.status = 'PENDING' then
    raise exception 'transação %: PENDING_REFERENCE -> PENDING é inválida', old.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
      new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
      new.reference_external_transaction_id, new.created_at)
     is distinct from
     (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
      old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
      old.reference_external_transaction_id, old.created_at) then
    raise exception 'transação %: campos de negócio são imutáveis', old.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  if new.reference_attempts < old.reference_attempts then
    raise exception 'transação %: reference_attempts não pode diminuir', old.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  return new;
end $$`,
  /* sql */ `create trigger tg_wager_tx_guard_update before update on wager_transactions
    for each row execute function wager_transactions_guard_update()`,
];

/**
 * Consistência cruzada conferida no COMMIT (constraint triggers diferidos): saldo materializado,
 * ledger e transação não divergem, independente da ordem dos comandos dentro da transação.
 */
const CROSS_CONSISTENCY = [
  /* sql */ `
create function ledger_entry_consistency() returns trigger language plpgsql as $$
declare
  tx   wager_transactions%rowtype;
  prev wallet_ledger_entries%rowtype;
  w    wallets%rowtype;
  expected_direction text;
  head_version integer;
begin
  -- 1) lançamento x transação: só transação PROCESSED que move saldo, mesmo valor e moeda,
  --    direção coerente com o kind (ROLLBACK é o inverso da referência)
  select * into tx from wager_transactions where id = new.transaction_id;
  expected_direction := case tx.kind
    when 'BET' then 'DEBIT'
    when 'LOSS' then null
    when 'ROLLBACK' then (select case r.kind when 'BET' then 'CREDIT' else 'DEBIT' end
                            from wager_transactions r where r.id = tx.reference_transaction_id)
    else 'CREDIT' end;
  if tx.status is distinct from 'PROCESSED'
     or expected_direction is distinct from new.direction
     or tx.amount <> new.amount
     or tx.currency <> new.currency then
    raise exception 'lançamento % não corresponde à transação %', new.id, new.transaction_id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;

  -- 2) encadeamento: balance_before = balance_after do lançamento anterior (versão - 1),
  --    ou 0.00 no primeiro lançamento da wallet
  select * into prev from wallet_ledger_entries
   where wallet_id = new.wallet_id and wallet_version < new.wallet_version
   order by wallet_version desc limit 1;
  if (found and (prev.wallet_version <> new.wallet_version - 1
                 or prev.balance_after <> new.balance_before))
     or (not found and new.balance_before <> 0) then
    raise exception 'lançamento % quebra o encadeamento do ledger da wallet %', new.id, new.wallet_id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;

  -- 3) se é o último lançamento, a wallet reflete exatamente ele
  select max(wallet_version) into head_version from wallet_ledger_entries where wallet_id = new.wallet_id;
  if head_version = new.wallet_version then
    select * into w from wallets where id = new.wallet_id;
    if w.balance is distinct from new.balance_after or w.version is distinct from new.wallet_version then
      raise exception 'wallet % diverge do último lançamento do ledger', new.wallet_id
        using errcode = 'integrity_constraint_violation', constraint = tg_name;
    end if;
  end if;
  return null;
end $$`,
  /* sql */ `create constraint trigger tg_ledger_consistency after insert on wallet_ledger_entries
    deferrable initially deferred for each row execute function ledger_entry_consistency()`,

  /* sql */ `
create function wallet_matches_ledger() returns trigger language plpgsql as $$
declare
  w    wallets%rowtype;
  head wallet_ledger_entries%rowtype;
begin
  -- relê a linha: o evento diferido pode ser de um estado intermediário da transação
  select * into w from wallets where id = new.id;
  select * into head from wallet_ledger_entries where wallet_id = new.id
   order by wallet_version desc limit 1;
  if (found and (w.balance <> head.balance_after or w.version <> head.wallet_version))
     or (not found and (w.balance <> 0 or w.version <> 1)) then
    raise exception 'saldo da wallet % diverge do ledger', new.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  return null;
end $$`,
  /* sql */ `create constraint trigger tg_wallet_matches_ledger after insert or update on wallets
    deferrable initially deferred for each row execute function wallet_matches_ledger()`,

  /* sql */ `
create function processed_transaction_has_entry() returns trigger language plpgsql as $$
begin
  if exists (select 1 from wager_transactions t
              where t.id = new.id and t.status = 'PROCESSED' and t.kind <> 'LOSS')
     and not exists (select 1 from wallet_ledger_entries l where l.transaction_id = new.id) then
    raise exception 'transação % está PROCESSED e move saldo, mas não tem lançamento', new.id
      using errcode = 'integrity_constraint_violation', constraint = tg_name;
  end if;
  return null;
end $$`,
  /* sql */ `create constraint trigger tg_wager_tx_has_entry after insert or update of status on wager_transactions
    deferrable initially deferred for each row execute function processed_transaction_has_entry()`,
];

const DOWN = [
  'drop table if exists outbox_messages',
  'drop table if exists inbox_messages',
  'drop table if exists wallet_ledger_entries',
  'drop table if exists wager_transactions',
  'drop table if exists wallets',
  'drop function if exists processed_transaction_has_entry()',
  'drop function if exists wallet_matches_ledger()',
  'drop function if exists ledger_entry_consistency()',
  'drop function if exists wager_transactions_guard_update()',
  'drop function if exists wallets_guard_update()',
  'drop function if exists forbid_mutation()',
];

export class Migration20261106120000WageringSchema extends Migration {
  override async up(): Promise<void> {
    for (const sql of [
      WALLETS,
      WAGER_TRANSACTIONS,
      ...WAGER_TRANSACTIONS_INDEXES,
      LEDGER,
      INBOX,
      OUTBOX,
      ...OUTBOX_INDEXES,
      ...FORBID_MUTATION,
      ...WALLETS_GUARD,
      ...WAGER_TRANSACTIONS_GUARD,
      ...CROSS_CONSISTENCY,
    ]) {
      this.addSql(sql);
    }
  }

  override async down(): Promise<void> {
    for (const sql of DOWN) {
      this.addSql(sql);
    }
  }
}
