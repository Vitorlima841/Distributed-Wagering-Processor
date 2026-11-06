import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain';
import { expectBalanceMatchesLedger } from './database';

/**
 * Checagem final dos testes de concorrência, por wallet, lendo direto do Postgres:
 *  1. `wallet.balance == saldo reconstruído pelo ledger` (invariante de todos os testes);
 *  2. ledger em sequência: versões contíguas, sem buraco, cada `balance_before` é o `balance_after`
 *     anterior, a aritmética fecha e nenhum saldo intermediário é negativo; a wallet está na versão
 *     e no saldo do último lançamento (sem lost update);
 *  3. exatamente um lançamento por transação PROCESSED que move saldo, nenhum para as demais;
 *  4. eventos na outbox: exatamente os do desfecho de cada transação (nem duplicados nem faltando)
 *     e nenhum evento de transação que não existe. Uma reversão resolvida depois pelo worker de
 *     PENDING_REFERENCE tem também o `WagerTransactionPendingReference` da chegada.
 * O banco já impõe boa parte disso; o teste confere o resultado do lado de fora.
 */
export async function expectConsistentWallets(
  orm: MikroORM,
  walletIds: Iterable<string>,
): Promise<void> {
  const ids = [...walletIds];
  await expectBalanceMatchesLedger(orm, ids);
  for (const walletId of ids) {
    await expectLedgerChain(orm, walletId);
  }
  await expectOneEffectPerTransaction(orm, ids);
}

interface ChainRow {
  walletVersion: number;
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  kind: string;
}

async function expectLedgerChain(orm: MikroORM, walletId: string): Promise<void> {
  const em = orm.em.fork();
  const [wallet] = await em.execute<{ balance: string; currency: string; version: number }[]>(
    'select balance::text as balance, currency, version from wallets where id = ?',
    [walletId],
  );
  if (!wallet) {
    throw new Error(`wallet ${walletId} não existe`);
  }
  const entries = await em.execute<ChainRow[]>(
    `select l.wallet_version as "walletVersion", l.direction, l.amount::text as amount, l.currency,
            l.balance_before::text as "balanceBefore", l.balance_after::text as "balanceAfter",
            t.kind
       from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
      where l.wallet_id = ? order by l.wallet_version`,
    [walletId],
  );
  const money = (amount: string) => Money.from({ amount, currency: wallet.currency });
  // a wallet nasce na versão 1: com saldo inicial, o CREDIT da abertura é a versão 1; sem ele, o
  // primeiro lançamento é a versão 2
  const firstVersion = entries[0]?.kind === 'OPENING' ? 1 : 2;
  let previous = money('0.00');
  let lastVersion = 1;
  entries.forEach((entry, index) => {
    const before = money(entry.balanceBefore);
    const after = money(entry.balanceAfter);
    const amount = money(entry.amount);
    const expectedAfter =
      entry.direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
    expect({ walletId, version: entry.walletVersion, before: entry.balanceBefore }).toEqual({
      walletId,
      version: firstVersion + index,
      before: previous.toJSON().amount,
    });
    expect(after.equals(expectedAfter)).toBe(true);
    expect(after.isNegative()).toBe(false);
    previous = after;
    lastVersion = entry.walletVersion;
  });
  expect({ walletId, balance: wallet.balance, version: wallet.version }).toEqual({
    walletId,
    balance: previous.toJSON().amount,
    version: lastVersion,
  });
}

interface EffectRow {
  id: string;
  kind: string;
  status: string;
  entries: number;
  /**
   * Terminal resolvido pelo worker de PENDING_REFERENCE. O use case grava `processed_at` com o
   * instante de criação (decisão na chegada); o worker grava o instante da tentativa, sempre
   * depois (a primeira tentativa vence 1s após a chegada).
   */
  resolvedLater: boolean;
}

/**
 * Lançamentos e eventos de todas as transações das wallets, com uma única varredura da outbox (o
 * banco de teste só cresce, e a outbox não tem índice pelo conteúdo do evento).
 */
async function expectOneEffectPerTransaction(orm: MikroORM, walletIds: string[]): Promise<void> {
  if (walletIds.length === 0) {
    return;
  }
  const em = orm.em.fork();
  const csv = walletIds.join(',');
  const rows = await em.execute<EffectRow[]>(
    `select t.id, t.kind, t.status,
            (select count(*)::int from wallet_ledger_entries l where l.transaction_id = t.id)
              as entries,
            (t.processed_at is not null and t.processed_at > t.created_at) as "resolvedLater"
       from wager_transactions t
      where t.wallet_id = any(string_to_array(?, ',')::uuid[])`,
    [csv],
  );
  const eventRows = await em.execute<{ transactionId: string; events: string[] }[]>(
    `select o.payload -> 'data' ->> 'transactionId' as "transactionId",
            array_agg(o.event_type order by o.event_type) as events
       from outbox_messages o
      where o.payload -> 'data' ->> 'walletId' = any(string_to_array(?, ','))
      group by 1`,
    [csv],
  );
  const eventsOf = new Map(eventRows.map((row) => [row.transactionId, row.events]));
  for (const row of rows) {
    const movesBalance = row.status === 'PROCESSED' && row.kind !== 'LOSS';
    expect({ tx: row.id, entries: row.entries }).toEqual({
      tx: row.id,
      entries: movesBalance ? 1 : 0,
    });
    expect({ tx: row.id, events: eventsOf.get(row.id) ?? [] }).toEqual({
      tx: row.id,
      events: expectedEvents(row),
    });
  }
  // nenhum evento aponta para uma transação inexistente (ex.: de uma transação desfeita)
  const known = new Set(rows.map((row) => row.id));
  expect(eventRows.filter((row) => !known.has(row.transactionId))).toEqual([]);
}

function expectedEvents(row: EffectRow): string[] {
  const terminal = terminalEvents(row);
  return row.resolvedLater ? ['WagerTransactionPendingReference', ...terminal].sort() : terminal;
}

function terminalEvents(row: EffectRow): string[] {
  switch (row.status) {
    case 'PROCESSED':
      return row.kind === 'LOSS'
        ? ['WagerTransactionProcessed']
        : ['WagerTransactionProcessed', 'WalletBalanceChanged'];
    case 'REJECTED':
      return ['WagerTransactionRejected'];
    case 'PENDING_REFERENCE':
      return ['WagerTransactionPendingReference'];
    default:
      return [];
  }
}
