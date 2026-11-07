import type { Money } from '../../domain';

/** Saldo materializado e totais do ledger de uma wallet, lidos num único snapshot. */
export interface WalletLedgerTotals {
  walletId: string;
  storedBalance: Money;
  /** Soma dos lançamentos CREDIT (0.00 se não houver). */
  credits: Money;
  /** Soma dos lançamentos DEBIT (0.00 se não houver). */
  debits: Money;
  entries: number;
}

export interface ReconciliationReader {
  /**
   * Lê saldo e totais de uma vez (um só snapshot), sem travar a wallet: escritas concorrentes
   * não produzem falsa divergência. `undefined` se a wallet não existir.
   */
  read(walletId: string): Promise<WalletLedgerTotals | undefined>;
}

export interface ReconciliationDivergence {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  checkedEntries: number;
}

/** Sinaliza divergências (log `warn` e métrica). Nunca corrige nada. */
export interface ReconciliationMonitor {
  divergenceDetected(divergence: ReconciliationDivergence): void;
}

export const RECONCILIATION_READER = Symbol('RECONCILIATION_READER');
export const RECONCILIATION_MONITOR = Symbol('RECONCILIATION_MONITOR');
