import type { ReconciliationDivergence, ReconciliationMonitor } from '../../application/ports';
import type { Logger } from './logger';

/**
 * Divergência de reconciliação vira log `warn` estruturado. Só o necessário para investigar
 * (wallet, diferença, lançamentos conferidos), sem saldo nem payload completo. Métrica: fase 8.
 */
export class LoggingReconciliationMonitor implements ReconciliationMonitor {
  constructor(private readonly logger: Logger) {}

  divergenceDetected(divergence: ReconciliationDivergence): void {
    this.logger.warn(
      {
        event: 'reconciliation_divergence',
        walletId: divergence.walletId,
        difference: divergence.difference.toJSON(),
        checkedEntries: divergence.checkedEntries,
      },
      'saldo materializado diverge do ledger',
    );
  }
}
