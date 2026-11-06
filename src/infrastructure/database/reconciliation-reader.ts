import type { MikroORM } from '@mikro-orm/postgresql';
import type { ReconciliationReader, WalletLedgerTotals } from '../../application/ports';
import { Money } from '../../domain';
import { translatePersistenceError } from './persistence-error-translator';

interface TotalsRow {
  balance: string;
  currency: string;
  credits: string;
  debits: string;
  entries: number;
}

/**
 * Um único SELECT: em READ COMMITTED, cada comando enxerga um snapshot só, então saldo e somas do
 * ledger são do mesmo instante, sem travar a wallet (escritores concorrentes não esperam e não
 * geram falsa divergência). As somas são `numeric` no Postgres e chegam como string.
 */
const TOTALS_SQL = /* sql */ `
select w.balance::text                                                           as balance,
       w.currency                                                                as currency,
       coalesce(sum(l.amount) filter (where l.direction = 'CREDIT'), 0)::numeric(20,2)::text as credits,
       coalesce(sum(l.amount) filter (where l.direction = 'DEBIT'), 0)::numeric(20,2)::text  as debits,
       count(l.id)::int                                                          as entries
  from wallets w
  left join wallet_ledger_entries l on l.wallet_id = w.id
 where w.id = ?
 group by w.id`;

export class MikroOrmReconciliationReader implements ReconciliationReader {
  constructor(private readonly orm: MikroORM) {}

  async read(walletId: string): Promise<WalletLedgerTotals | undefined> {
    let rows: TotalsRow[];
    try {
      rows = await this.orm.em.fork().execute<TotalsRow[]>(TOTALS_SQL, [walletId]);
    } catch (error) {
      throw translatePersistenceError(error);
    }
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const money = (amount: string) => Money.from({ amount, currency: row.currency });
    return {
      walletId,
      storedBalance: money(row.balance),
      credits: money(row.credits),
      debits: money(row.debits),
      entries: row.entries,
    };
  }
}
