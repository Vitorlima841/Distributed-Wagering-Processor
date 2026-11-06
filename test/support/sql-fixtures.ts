import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain';
import { inTransaction } from './database';

/**
 * Fixtures em SQL puro (sem repositórios): os testes de constraint provam que o banco barra
 * dados inválidos sozinho. A aritmética usa `Money` (decimal.js), nunca number.
 */

export const HASH = 'a'.repeat(64);

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
}

export interface TxRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceAfter: string | null;
  balanceAfterCurrency: string | null;
  referenceAttempts: number;
  nextAttemptAt: Date | null;
  processedAt: Date | null;
}

export interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT' | string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
}

export function insertWallet(em: EntityManager, w: WalletRow): Promise<unknown> {
  return em.execute(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, now(), now())`,
    [w.id, w.playerId, w.currency, w.balance, w.version],
  );
}

export function insertTx(em: EntityManager, t: TxRow): Promise<unknown> {
  return em.execute(
    `insert into wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, balance_after, balance_after_currency,
       reference_attempts, next_attempt_at, created_at, processed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?)`,
    [
      t.id,
      t.providerId,
      t.externalTransactionId,
      t.idempotencyKey,
      t.payloadHash,
      t.walletId,
      t.playerId,
      t.roundId,
      t.gameId,
      t.kind,
      t.amount,
      t.currency,
      t.referenceExternalTransactionId,
      t.referenceTransactionId,
      t.status,
      t.failureCode,
      t.balanceAfter,
      t.balanceAfterCurrency,
      t.referenceAttempts,
      t.nextAttemptAt,
      t.processedAt,
    ],
  );
}

export function insertLedger(em: EntityManager, e: LedgerRow): Promise<unknown> {
  return em.execute(
    `insert into wallet_ledger_entries (
       id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after,
       wallet_version, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      e.id,
      e.walletId,
      e.transactionId,
      e.direction,
      e.amount,
      e.currency,
      e.balanceBefore,
      e.balanceAfter,
      e.walletVersion,
    ],
  );
}

/** Linha de transação PROCESSED válida; `overrides` ajusta o que o teste precisa. */
export function txRow(wallet: WalletRow, overrides: Partial<TxRow> = {}): TxRow {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${randomUUID()}`;
  const providerId = overrides.providerId ?? 'provider-a';
  return {
    id: randomUUID(),
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: wallet.currency,
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    status: 'PROCESSED',
    failureCode: null,
    balanceAfter: wallet.balance,
    balanceAfterCurrency: wallet.currency,
    referenceAttempts: 0,
    nextAttemptAt: null,
    processedAt: new Date(),
    ...overrides,
  };
}

/** Wallet consistente: linha da wallet e, se o saldo inicial for > 0, OPENING + CREDIT. */
export async function openWallet(
  orm: MikroORM,
  { initial = '100.00', currency = 'BRL' }: { initial?: string; currency?: string } = {},
): Promise<WalletRow> {
  const wallet: WalletRow = {
    id: randomUUID(),
    playerId: randomUUID(),
    currency,
    balance: Money.from({ amount: initial, currency }).toJSON().amount,
    version: 1,
  };
  await inTransaction(orm, async (em) => {
    await insertWallet(em, wallet);
    if (Money.from({ amount: initial, currency }).isZero()) {
      return;
    }
    const opening = txRow(wallet, {
      providerId: 'internal',
      externalTransactionId: `opening:${wallet.id}`,
      idempotencyKey: `opening:${wallet.id}`,
      roundId: 'opening',
      gameId: 'internal',
      kind: 'OPENING',
      amount: wallet.balance,
    });
    await insertTx(em, opening);
    await insertLedger(em, {
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: opening.id,
      direction: 'CREDIT',
      amount: wallet.balance,
      currency,
      balanceBefore: '0.00',
      balanceAfter: wallet.balance,
      walletVersion: 1,
    });
  });
  return wallet;
}

export interface Movement {
  kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  externalTransactionId?: string;
  reference?: { id: string; externalTransactionId: string };
}

/**
 * Aplica um movimento PROCESSED consistente (transação + lançamento + wallet) com a wallet
 * travada, como o use case fará. Devolve a wallet atualizada e a transação criada.
 */
export async function applyMovement(
  orm: MikroORM,
  wallet: WalletRow,
  movement: Movement,
): Promise<{ wallet: WalletRow; tx: TxRow }> {
  return inTransaction(orm, async (em) => {
    const [current] = await em.execute<{ balance: string; version: number }[]>(
      'select balance::text as balance, version from wallets where id = ? for update',
      [wallet.id],
    );
    if (!current) {
      throw new Error(`wallet ${wallet.id} não existe`);
    }
    const before = Money.from({ amount: current.balance, currency: wallet.currency });
    const amount = Money.from({ amount: movement.amount, currency: wallet.currency });
    const after = movement.direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
    const next: WalletRow = {
      ...wallet,
      balance: after.toJSON().amount,
      version: current.version + 1,
    };
    const tx = txRow(next, {
      kind: movement.kind,
      amount: amount.toJSON().amount,
      ...(movement.externalTransactionId
        ? { externalTransactionId: movement.externalTransactionId }
        : {}),
      ...(movement.externalTransactionId
        ? { idempotencyKey: `provider-a:${movement.externalTransactionId}` }
        : {}),
      referenceExternalTransactionId: movement.reference?.externalTransactionId ?? null,
      referenceTransactionId: movement.reference?.id ?? null,
    });
    await insertTx(em, tx);
    await insertLedger(em, {
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: tx.id,
      direction: movement.direction,
      amount: tx.amount,
      currency: wallet.currency,
      balanceBefore: before.toJSON().amount,
      balanceAfter: next.balance,
      walletVersion: next.version,
    });
    await em.execute(
      'update wallets set balance = ?, version = ?, updated_at = now() where id = ?',
      [next.balance, next.version, wallet.id],
    );
    return { wallet: next, tx };
  });
}
