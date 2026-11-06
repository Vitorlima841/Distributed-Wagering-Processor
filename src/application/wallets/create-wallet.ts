import {
  Money,
  type MoneyProps,
  WagerTransaction,
  WagerTransactionProcessed,
  Wallet,
  WalletBalanceChanged,
} from '../../domain';
import { WalletAlreadyExistsError } from '../errors';
import {
  type Clock,
  type IdGenerator,
  UniqueConstraint,
  UniqueViolationError,
  type UnitOfWork,
} from '../ports';
import { normalizeUuid } from '../shared/identifiers';
import { enqueueEvents, eventContextFactory } from '../wagering/apply-wager';
import { toWalletView, type WalletView } from './views';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * Abre a wallet. Saldo inicial > 0 gera, na mesma transação SQL, a transação interna OPENING
 * (PROCESSED), o lançamento CREDIT de 0.00 até o saldo inicial e os eventos
 * WagerTransactionProcessed + WalletBalanceChanged.
 *
 * Duplicidade (player + moeda) é decidida por `ux_wallets_player_currency`, não por uma leitura
 * prévia: duas criações simultâneas não passam juntas.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const playerId = normalizeUuid('playerId', command.playerId);
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.newId();
    const openingTransactionId = this.ids.newId();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.newId(),
      now,
    });

    try {
      await this.uow.run(async (scope) => {
        await scope.wallets.add(wallet);
        if (!openingEntry) {
          return;
        }
        const opening = WagerTransaction.opening({
          id: openingTransactionId,
          walletId,
          playerId,
          money: initialBalance,
          now,
        });
        opening.markProcessed(undefined, wallet.balance, now);
        await scope.transactions.add(opening);
        await scope.ledger.append(openingEntry);
        const context = eventContextFactory(this.ids, now, {
          correlationId: command.correlationId,
        });
        await enqueueEvents(scope, [
          WagerTransactionProcessed.from(opening, context()),
          WalletBalanceChanged.from(wallet, openingEntry, context()),
        ]);
      });
    } catch (error) {
      if (
        error instanceof UniqueViolationError &&
        error.constraint === UniqueConstraint.WalletPlayerCurrency
      ) {
        const existing = await this.uow.run((scope) =>
          scope.wallets.findByPlayerAndCurrency(playerId, wallet.currency),
        );
        throw new WalletAlreadyExistsError(playerId, wallet.currency, existing?.id);
      }
      throw error;
    }
    return toWalletView(wallet);
  }
}
