import { RequestValidationError, WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports';
import { normalizeUuid } from '../shared/identifiers';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import { type LedgerPageView, toLedgerEntryView, toWalletView, type WalletView } from './views';

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 200;

export interface ListLedgerQuery {
  walletId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const id = normalizeUuid('walletId', walletId);
    const wallet = await this.uow.run((scope) => scope.wallets.findById(id));
    if (!wallet) {
      throw new WalletNotFoundError(id);
    }
    return toWalletView(wallet);
  }
}

/** Ledger da wallet, do lançamento mais antigo ao mais novo, paginado por cursor opaco. */
export class ListWalletLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(query: ListLedgerQuery): Promise<LedgerPageView> {
    const walletId = normalizeUuid('walletId', query.walletId);
    const limit = query.limit ?? DEFAULT_LEDGER_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_PAGE_SIZE) {
      throw new RequestValidationError(
        'INVALID_LIMIT',
        `limit deve ser um inteiro entre 1 e ${MAX_LEDGER_PAGE_SIZE}`,
      );
    }
    const afterWalletVersion = decodeLedgerCursor(walletId, query.cursor);

    const entries = await this.uow.run(async (scope) => {
      if (!(await scope.wallets.findById(walletId))) {
        throw new WalletNotFoundError(walletId);
      }
      // Um a mais que o limite diz se existe próxima página sem uma consulta extra.
      return scope.ledger.listByWallet(walletId, { afterWalletVersion, limit: limit + 1 });
    });
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      walletId,
      entries: page.map(toLedgerEntryView),
      nextCursor:
        entries.length > limit && last ? encodeLedgerCursor(walletId, last.walletVersion) : null,
    };
  }
}
