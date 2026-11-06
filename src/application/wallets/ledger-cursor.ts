import { RequestValidationError } from '../errors';

/**
 * Cursor opaco do ledger: base64url de `{ v, w, after }`, em que `after` é a `walletVersion` do
 * último lançamento entregue. A versão é contígua por wallet e só cresce (o lock da wallet
 * serializa os lançamentos), então o cursor continua válido quando novos lançamentos chegam.
 * `w` amarra o cursor à wallet: usar o cursor de outra wallet é erro, não uma posição qualquer.
 */
const CURSOR_VERSION = 1;

interface CursorPayload {
  v: number;
  w: string;
  after: number;
}

export function encodeLedgerCursor(walletId: string, afterWalletVersion: number): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, w: walletId, after: afterWalletVersion };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Devolve a `walletVersion` a partir da qual listar. Cursor ausente = desde o início (0). */
export function decodeLedgerCursor(walletId: string, cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  let payload: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('não é base64url');
    }
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const { v, w, after } = (payload ?? {}) as Partial<CursorPayload>;
  if (v !== CURSOR_VERSION || w !== walletId || !Number.isInteger(after) || (after as number) < 1) {
    throw invalidCursor();
  }
  return after as number;
}

function invalidCursor(): RequestValidationError {
  return new RequestValidationError('INVALID_CURSOR', 'Cursor de paginação inválido');
}
