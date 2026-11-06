import { WalletNotFoundError } from '../errors';
import type { ReconciliationMonitor, ReconciliationReader } from '../ports';
import { normalizeUuid } from '../shared/identifiers';
import type { ReconciliationReport } from './views';

/**
 * Confere o saldo materializado contra o saldo reconstruído pelo ledger (créditos − débitos).
 * Divergência não é corrigida: é sinalizada na resposta e no monitor (log; métrica na fase 8).
 *
 * O banco já impede divergência no COMMIT (triggers diferidos, ARCHITECTURE §15); esta é a
 * auditoria independente, que pega o que escapar disso (restore parcial, escrita manual etc.).
 */
export class ReconcileWallet {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly monitor: ReconciliationMonitor,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const id = normalizeUuid('walletId', walletId);
    const totals = await this.reader.read(id);
    if (!totals) {
      throw new WalletNotFoundError(id);
    }
    // subtract pode dar negativo: é exatamente o caso de um ledger corrompido.
    const calculatedBalance = totals.credits.subtract(totals.debits);
    const difference = totals.storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.monitor.divergenceDetected({
        walletId: id,
        storedBalance: totals.storedBalance,
        calculatedBalance,
        difference,
        checkedEntries: totals.entries,
      });
    }
    return {
      walletId: id,
      storedBalance: totals.storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: totals.entries,
    };
  }
}
