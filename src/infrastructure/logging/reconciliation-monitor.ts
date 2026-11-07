import type { ReconciliationDivergence, ReconciliationMonitor } from '../../application/ports';
import type { WageringMetrics } from '../observability/metrics';
import type { Logger } from './logger';

/**
 * Divergência de reconciliação vira log `warn` estruturado e conta em
 * `wagering_reconciliation_divergences_total`. O log traz só o necessário para investigar
 * (wallet, diferença, lançamentos conferidos), sem saldo nem payload completo.
 */
export class LoggingReconciliationMonitor implements ReconciliationMonitor {
  constructor(
    private readonly logger: Logger,
    private readonly metrics: WageringMetrics,
  ) {}

  divergenceDetected(divergence: ReconciliationDivergence): void {
    this.metrics.recordReconciliationDivergence();
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
