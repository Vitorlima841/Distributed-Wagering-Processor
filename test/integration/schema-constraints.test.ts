import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  createTestOrm,
  exec,
  expectBalanceMatchesLedger,
  expectViolation,
  inTransaction,
  SQLSTATE,
} from '../support/database';
import {
  applyMovement,
  insertLedger,
  insertTx,
  insertWallet,
  openWallet,
  txRow,
  type WalletRow,
} from '../support/sql-fixtures';

/**
 * Restrição 9: unicidade, imutabilidade e não-negatividade garantidas NO SCHEMA. Tudo aqui é SQL
 * puro, sem repositórios nem domínio: prova que o banco barra sozinho o dado inválido.
 */
describe('constraints do schema (SQL puro contra o Postgres real)', () => {
  let orm: MikroORM;
  const wallets = new Set<string>();

  const open = async (initial = '100.00', currency = 'BRL'): Promise<WalletRow> => {
    const wallet = await openWallet(orm, { initial, currency });
    wallets.add(wallet.id);
    return wallet;
  };

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterEach(async () => {
    await expectBalanceMatchesLedger(orm, wallets);
    wallets.clear();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  describe('saldo nunca negativo', () => {
    test('INSERT de wallet com saldo negativo', async () => {
      await expectViolation(
        () =>
          exec(
            orm,
            `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
             values (?, ?, 'BRL', '-0.01', 1, now(), now())`,
            [randomUUID(), randomUUID()],
          ),
        { constraint: 'ck_wallets_balance_non_negative', code: SQLSTATE.check },
      );
    });

    test('UPDATE que deixaria o saldo negativo', async () => {
      const wallet = await open('10.00');
      await expectViolation(
        () =>
          exec(orm, `update wallets set balance = '-5.00', version = 2 where id = ?`, [wallet.id]),
        { constraint: 'ck_wallets_balance_non_negative', code: SQLSTATE.check },
      );
    });

    test('lançamento com saldo resultante negativo', async () => {
      const wallet = await open('5.00');
      const bet = txRow(wallet, { amount: '10.00' });
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, bet);
            await insertLedger(em, {
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: bet.id,
              direction: 'DEBIT',
              amount: '10.00',
              currency: 'BRL',
              balanceBefore: '5.00',
              balanceAfter: '-5.00',
              walletVersion: 2,
            });
          }),
        { constraint: 'ck_ledger_balances_non_negative', code: SQLSTATE.check },
      );
    });
  });

  describe('uma wallet por player + moeda', () => {
    test('wallet duplicada', async () => {
      const wallet = await open();
      await expectViolation(
        () =>
          inTransaction(orm, (em) =>
            insertWallet(em, { ...wallet, id: randomUUID(), balance: '0.00', version: 1 }),
          ),
        { constraint: 'ux_wallets_player_currency', code: SQLSTATE.unique },
      );
    });

    test('mesmo player em outra moeda é permitido', async () => {
      const wallet = await open();
      const other = { ...wallet, id: randomUUID(), currency: 'USD', balance: '0.00', version: 1 };
      await inTransaction(orm, (em) => insertWallet(em, other));
      wallets.add(other.id);
    });

    test('moeda fora do ISO-4217 (3 letras maiúsculas)', async () => {
      await expectViolation(
        () =>
          inTransaction(orm, (em) =>
            insertWallet(em, {
              id: randomUUID(),
              playerId: randomUUID(),
              currency: 'BR',
              balance: '0.00',
              version: 1,
            }),
          ),
        { constraint: 'ck_wallets_currency', code: SQLSTATE.check },
      );
    });
  });

  describe('ledger imutável (append-only)', () => {
    test('UPDATE, DELETE e TRUNCATE falham', async () => {
      const wallet = await open();
      const [entry] = await orm.em
        .fork()
        .execute<{ id: string }[]>('select id from wallet_ledger_entries where wallet_id = ?', [
          wallet.id,
        ]);
      const id = entry?.id;

      await expectViolation(
        () => exec(orm, `update wallet_ledger_entries set amount = '1.00' where id = ?`, [id]),
        { constraint: 'tg_ledger_append_only', code: SQLSTATE.trigger },
      );
      await expectViolation(
        () => exec(orm, 'delete from wallet_ledger_entries where id = ?', [id]),
        {
          constraint: 'tg_ledger_append_only',
          code: SQLSTATE.trigger,
        },
      );
      await expectViolation(() => exec(orm, 'truncate wallet_ledger_entries cascade'), {
        constraint: 'tg_ledger_no_truncate',
        code: SQLSTATE.trigger,
      });
    });
  });

  describe('aritmética do lançamento', () => {
    const entryFor = (wallet: WalletRow, txId: string) => ({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: txId,
      currency: 'BRL',
      walletVersion: 2,
    });

    test('CREDIT e DEBIT com balance_after errado', async () => {
      const wallet = await open();
      const win = txRow(wallet, { kind: 'WIN', amount: '10.00' });
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, win);
            await insertLedger(em, {
              ...entryFor(wallet, win.id),
              direction: 'CREDIT',
              amount: '10.00',
              balanceBefore: '100.00',
              balanceAfter: '120.00',
            });
          }),
        { constraint: 'ck_ledger_arithmetic', code: SQLSTATE.check },
      );

      const bet = txRow(wallet, { amount: '10.00' });
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, bet);
            await insertLedger(em, {
              ...entryFor(wallet, bet.id),
              direction: 'DEBIT',
              amount: '10.00',
              balanceBefore: '100.00',
              balanceAfter: '100.00',
            });
          }),
        { constraint: 'ck_ledger_arithmetic', code: SQLSTATE.check },
      );
    });

    test('lançamento com valor zero ou direção desconhecida', async () => {
      const wallet = await open();
      const tx = txRow(wallet, { kind: 'WIN', amount: '10.00' });
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, tx);
            await insertLedger(em, {
              ...entryFor(wallet, tx.id),
              direction: 'CREDIT',
              amount: '0.00',
              balanceBefore: '100.00',
              balanceAfter: '100.00',
            });
          }),
        { constraint: 'ck_ledger_amount_positive', code: SQLSTATE.check },
      );
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, tx);
            await insertLedger(em, {
              ...entryFor(wallet, tx.id),
              direction: 'REFUND',
              amount: '10.00',
              balanceBefore: '100.00',
              balanceAfter: '110.00',
            });
          }),
        // direção inválida também viola a aritmética; o Postgres avalia CHECKs em ordem alfabética
        { constraint: 'ck_ledger_arithmetic', code: SQLSTATE.check },
      );
    });

    test('dois lançamentos para a mesma transação', async () => {
      const wallet = await open();
      const { tx, wallet: after } = await applyMovement(orm, wallet, {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '10.00',
      });
      await expectViolation(
        () =>
          inTransaction(orm, (em) =>
            insertLedger(em, {
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: tx.id,
              direction: 'DEBIT',
              amount: '10.00',
              currency: 'BRL',
              balanceBefore: after.balance,
              balanceAfter: '80.00',
              walletVersion: after.version + 1,
            }),
          ),
        { constraint: 'ux_ledger_transaction', code: SQLSTATE.unique },
      );
    });
  });

  describe('reversão uma única vez (índice único parcial)', () => {
    test('REFUND e depois ROLLBACK da mesma BET: o segundo é barrado', async () => {
      const wallet = await open();
      const bet = await applyMovement(orm, wallet, {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '30.00',
      });
      const reference = { id: bet.tx.id, externalTransactionId: bet.tx.externalTransactionId };
      const refund = await applyMovement(orm, bet.wallet, {
        kind: 'REFUND',
        direction: 'CREDIT',
        amount: '30.00',
        reference,
      });

      await expectViolation(
        () =>
          applyMovement(orm, refund.wallet, {
            kind: 'ROLLBACK',
            direction: 'CREDIT',
            amount: '30.00',
            reference,
          }),
        { constraint: 'ux_wager_tx_reversal_once', code: SQLSTATE.unique },
      );
      await expectViolation(
        () =>
          applyMovement(orm, refund.wallet, {
            kind: 'REFUND',
            direction: 'CREDIT',
            amount: '30.00',
            reference,
          }),
        { constraint: 'ux_wager_tx_reversal_once', code: SQLSTATE.unique },
      );
    });

    test('ROLLBACK do REFUND (outra referência) e reversão REJECTED continuam permitidos', async () => {
      const wallet = await open();
      const bet = await applyMovement(orm, wallet, {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '30.00',
      });
      const refund = await applyMovement(orm, bet.wallet, {
        kind: 'REFUND',
        direction: 'CREDIT',
        amount: '30.00',
        reference: { id: bet.tx.id, externalTransactionId: bet.tx.externalTransactionId },
      });
      // REJECTED não entra no índice: fica auditável sem colidir
      await inTransaction(orm, (em) =>
        insertTx(
          em,
          txRow(refund.wallet, {
            kind: 'ROLLBACK',
            amount: '30.00',
            referenceExternalTransactionId: bet.tx.externalTransactionId,
            status: 'REJECTED',
            failureCode: 'ALREADY_REVERSED',
          }),
        ),
      );
      const rollback = await applyMovement(orm, refund.wallet, {
        kind: 'ROLLBACK',
        direction: 'DEBIT',
        amount: '30.00',
        reference: { id: refund.tx.id, externalTransactionId: refund.tx.externalTransactionId },
      });
      expect(rollback.wallet.balance).toBe('70.00');
    });

    test('reversão PROCESSED sem referência resolvida (NULL escaparia do índice)', async () => {
      const wallet = await open();
      await expectViolation(
        () =>
          inTransaction(orm, (em) =>
            insertTx(
              em,
              txRow(wallet, {
                kind: 'REFUND',
                referenceExternalTransactionId: 'bet-x',
                referenceTransactionId: null,
              }),
            ),
          ),
        { constraint: 'ck_wager_tx_resolved_reference', code: SQLSTATE.check },
      );
    });
  });

  describe('idempotência', () => {
    test('idempotency key duplicada', async () => {
      const wallet = await open();
      const first = txRow(wallet, { kind: 'LOSS', amount: '0.00' });
      await inTransaction(orm, (em) => insertTx(em, first));
      await expectViolation(
        () =>
          inTransaction(orm, (em) =>
            insertTx(
              em,
              txRow(wallet, {
                kind: 'LOSS',
                amount: '0.00',
                externalTransactionId: 'outro-id',
                idempotencyKey: first.idempotencyKey,
              }),
            ),
          ),
        { constraint: 'ux_wager_tx_idempotency_key', code: SQLSTATE.unique },
      );
    });

    test('(provider_id, external_transaction_id) duplicado com outra key', async () => {
      const wallet = await open();
      const first = txRow(wallet, { kind: 'LOSS', amount: '0.00' });
      await inTransaction(orm, (em) => insertTx(em, first));
      await expectViolation(
        () =>
          inTransaction(orm, (em) =>
            insertTx(
              em,
              txRow(wallet, {
                kind: 'LOSS',
                amount: '0.00',
                externalTransactionId: first.externalTransactionId,
                idempotencyKey: `outra-key-${randomUUID()}`,
              }),
            ),
          ),
        { constraint: 'ux_wager_tx_provider_external', code: SQLSTATE.unique },
      );
    });

    test('uma única abertura (OPENING) por wallet', async () => {
      const wallet = await open('0.00');
      const opening = {
        providerId: 'internal',
        externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `opening:${wallet.id}`,
        kind: 'OPENING',
      };
      await expectViolation(
        () =>
          inTransaction(orm, (em) =>
            insertTx(em, txRow(wallet, { ...opening, providerId: 'provider-a' })),
          ),
        { constraint: 'ck_wager_tx_opening', code: SQLSTATE.check },
      );
      await expectViolation(
        () =>
          inTransaction(orm, (em) =>
            insertTx(em, txRow(wallet, { ...opening, idempotencyKey: 'opening:outra' })),
          ),
        { constraint: 'ck_wager_tx_opening_shape', code: SQLSTATE.check },
      );
    });
  });

  describe('máquina de estados da transação (CHECKs)', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['REJECTED sem failure_code', { status: 'REJECTED' }, 'ck_wager_tx_failure_iff_unsuccessful'],
      [
        'PROCESSED com failure_code',
        { failureCode: 'INSUFFICIENT_FUNDS' },
        'ck_wager_tx_failure_iff_unsuccessful',
      ],
      [
        'FAILED com código de negócio',
        { status: 'FAILED', failureCode: 'INSUFFICIENT_FUNDS' },
        'ck_wager_tx_failed_is_infra',
      ],
      [
        'REJECTED com código de infraestrutura',
        { status: 'REJECTED', failureCode: 'INFRA_PERMANENT_ERROR' },
        'ck_wager_tx_failed_is_infra',
      ],
      [
        'failure_code desconhecido',
        { status: 'REJECTED', failureCode: 'OOPS' },
        'ck_wager_tx_failure_code',
      ],
      ['BET com valor zero', { amount: '0.00' }, 'ck_wager_tx_amount'],
      ['REFUND sem referência', { kind: 'REFUND' }, 'ck_wager_tx_reference_required'],
      [
        'BET com referência',
        { referenceExternalTransactionId: 'x' },
        'ck_wager_tx_reference_forbidden',
      ],
      ['terminal sem processed_at', { processedAt: null }, 'ck_wager_tx_terminal_processed_at'],
      [
        'PENDING_REFERENCE de uma BET',
        { status: 'PENDING_REFERENCE', processedAt: null, nextAttemptAt: new Date() },
        'ck_wager_tx_pending_reference',
      ],
      [
        'PROCESSED sem snapshot de saldo',
        { balanceAfter: null, balanceAfterCurrency: null },
        'ck_wager_tx_snapshot',
      ],
      ['snapshot sem moeda', { balanceAfterCurrency: null }, 'ck_wager_tx_snapshot_currency'],
      ['payload_hash fora do formato', { payloadHash: 'abc' }, 'ck_wager_tx_payload_hash'],
      ['kind desconhecido', { kind: 'JACKPOT' }, 'ck_wager_tx_kind'],
    ];

    for (const [name, overrides, constraint] of cases) {
      test(name, async () => {
        const wallet = await open();
        await expectViolation(
          () => inTransaction(orm, (em) => insertTx(em, txRow(wallet, overrides))),
          { constraint, code: SQLSTATE.check },
        );
      });
    }
  });

  describe('FKs compostas (conferidas no COMMIT)', () => {
    test('moeda do lançamento diferente da moeda da wallet', async () => {
      const wallet = await open();
      const win = txRow(wallet, { kind: 'WIN', amount: '1.00', currency: 'USD' });
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, win);
            await insertLedger(em, {
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: win.id,
              direction: 'CREDIT',
              amount: '1.00',
              currency: 'USD',
              balanceBefore: '100.00',
              balanceAfter: '101.00',
              walletVersion: 2,
            });
            await em.execute(`update wallets set balance = '101.00', version = 2 where id = ?`, [
              wallet.id,
            ]);
          }),
        { constraint: 'fk_ledger_wallet_currency', code: SQLSTATE.foreignKey },
      );
    });

    test('lançamento numa wallet diferente da wallet da transação', async () => {
      const walletA = await open();
      const walletB = await open();
      const win = txRow(walletA, { kind: 'WIN', amount: '1.00' });
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, win);
            await insertLedger(em, {
              id: randomUUID(),
              walletId: walletB.id,
              transactionId: win.id,
              direction: 'CREDIT',
              amount: '1.00',
              currency: 'BRL',
              balanceBefore: '100.00',
              balanceAfter: '101.00',
              walletVersion: 2,
            });
            // a wallet B fica coerente com o lançamento: só a FK composta está errada
            await em.execute(`update wallets set balance = '101.00', version = 2 where id = ?`, [
              walletB.id,
            ]);
          }),
        { constraint: 'fk_ledger_transaction_wallet', code: SQLSTATE.foreignKey },
      );
    });

    test('reversão que aponta para transação de outra wallet', async () => {
      const walletA = await open();
      const walletB = await open();
      const bet = await applyMovement(orm, walletA, {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '10.00',
      });
      await expectViolation(
        () =>
          applyMovement(orm, walletB, {
            kind: 'REFUND',
            direction: 'CREDIT',
            amount: '10.00',
            reference: { id: bet.tx.id, externalTransactionId: bet.tx.externalTransactionId },
          }),
        { constraint: 'fk_wager_tx_reference_same_wallet', code: SQLSTATE.foreignKey },
      );
    });

    test('transação para wallet inexistente', async () => {
      const ghost: WalletRow = {
        id: randomUUID(),
        playerId: randomUUID(),
        currency: 'BRL',
        balance: '0.00',
        version: 1,
      };
      await expectViolation(
        () =>
          inTransaction(orm, (em) => insertTx(em, txRow(ghost, { kind: 'LOSS', amount: '0.00' }))),
        { constraint: 'fk_wager_tx_wallet', code: SQLSTATE.foreignKey },
      );
    });
  });

  describe('guardas de UPDATE', () => {
    test('saldo muda sem incrementar version (e version muda sem saldo mudar)', async () => {
      const wallet = await open();
      await expectViolation(
        () => exec(orm, `update wallets set balance = '90.00' where id = ?`, [wallet.id]),
        { constraint: 'tg_wallets_guard_update', code: SQLSTATE.trigger },
      );
      await expectViolation(
        () => exec(orm, 'update wallets set version = 2 where id = ?', [wallet.id]),
        {
          constraint: 'tg_wallets_guard_update',
          code: SQLSTATE.trigger,
        },
      );
      await expectViolation(
        () => exec(orm, 'update wallets set player_id = ? where id = ?', [randomUUID(), wallet.id]),
        { constraint: 'tg_wallets_guard_update', code: SQLSTATE.trigger },
      );
    });

    test('lost update: UPDATE calculado sobre leitura antiga é barrado', async () => {
      const wallet = await open();
      // leitura "antiga": version 1, saldo 100.00
      const stale = { ...wallet };
      // outra instância aplica uma BET e confirma (version 2)
      await applyMovement(orm, wallet, { kind: 'BET', direction: 'DEBIT', amount: '30.00' });
      // a primeira grava o resultado calculado sobre a leitura antiga (version 1 + 1)
      await expectViolation(
        () =>
          exec(orm, `update wallets set balance = '90.00', version = ? where id = ?`, [
            stale.version + 1,
            wallet.id,
          ]),
        { constraint: 'tg_wallets_guard_update', code: SQLSTATE.trigger },
      );
    });

    test('transação em estado terminal não muda', async () => {
      const wallet = await open();
      const { tx } = await applyMovement(orm, wallet, {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '10.00',
      });
      await expectViolation(
        () =>
          exec(
            orm,
            `update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' where id = ?`,
            [tx.id],
          ),
        { constraint: 'tg_wager_tx_guard_update', code: SQLSTATE.trigger },
      );
    });

    test('campos de negócio de transação pendente são imutáveis', async () => {
      const wallet = await open();
      const pending = txRow(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-que-ainda-nao-chegou',
        status: 'PENDING_REFERENCE',
        processedAt: null,
        nextAttemptAt: new Date(),
      });
      await inTransaction(orm, (em) => insertTx(em, pending));
      await expectViolation(
        () =>
          exec(orm, `update wager_transactions set amount = '99.00' where id = ?`, [pending.id]),
        { constraint: 'tg_wager_tx_guard_update', code: SQLSTATE.trigger },
      );
      await expectViolation(
        () =>
          exec(
            orm,
            `update wager_transactions set status = 'PENDING', next_attempt_at = null, balance_after = null, balance_after_currency = null where id = ?`,
            [pending.id],
          ),
        { constraint: 'tg_wager_tx_guard_update', code: SQLSTATE.trigger },
      );
      // o caminho válido continua aberto: agendar nova tentativa
      await exec(
        orm,
        `update wager_transactions set reference_attempts = 1, next_attempt_at = now() where id = ?`,
        [pending.id],
      );
    });

    test('DELETE e TRUNCATE de transações falham', async () => {
      const wallet = await open();
      const loss = txRow(wallet, { kind: 'LOSS', amount: '0.00' });
      await inTransaction(orm, (em) => insertTx(em, loss));
      await expectViolation(
        () => exec(orm, 'delete from wager_transactions where id = ?', [loss.id]),
        {
          constraint: 'tg_wager_tx_no_delete',
          code: SQLSTATE.trigger,
        },
      );
      await expectViolation(() => exec(orm, 'truncate wager_transactions cascade'), {
        constraint: 'tg_wager_tx_no_truncate',
        code: SQLSTATE.trigger,
      });
    });
  });

  describe('consistência saldo ↔ ledger ↔ transação (triggers diferidos, no COMMIT)', () => {
    test('saldo da wallet muda sem lançamento', async () => {
      const wallet = await open();
      await expectViolation(
        () =>
          exec(orm, `update wallets set balance = '1000.00', version = 2 where id = ?`, [
            wallet.id,
          ]),
        { constraint: 'tg_wallet_matches_ledger', code: SQLSTATE.trigger },
      );
    });

    test('lançamento sem atualizar a wallet', async () => {
      const wallet = await open();
      const win = txRow(wallet, { kind: 'WIN', amount: '10.00' });
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, win);
            await insertLedger(em, {
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: win.id,
              direction: 'CREDIT',
              amount: '10.00',
              currency: 'BRL',
              balanceBefore: '100.00',
              balanceAfter: '110.00',
              walletVersion: 2,
            });
          }),
        { constraint: 'tg_ledger_consistency', code: SQLSTATE.trigger },
      );
    });

    test('encadeamento quebrado: balance_before diferente do lançamento anterior', async () => {
      const wallet = await open();
      const win = txRow(wallet, { kind: 'WIN', amount: '10.00' });
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, win);
            await insertLedger(em, {
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: win.id,
              direction: 'CREDIT',
              amount: '10.00',
              currency: 'BRL',
              balanceBefore: '50.00',
              balanceAfter: '60.00',
              walletVersion: 2,
            });
            await em.execute(`update wallets set balance = '60.00', version = 2 where id = ?`, [
              wallet.id,
            ]);
          }),
        { constraint: 'tg_ledger_consistency', code: SQLSTATE.trigger },
      );
    });

    test('lançamento com a mesma versão da wallet (lost update no ledger)', async () => {
      const wallet = await open();
      const win = txRow(wallet, { kind: 'WIN', amount: '10.00' });
      await expectViolation(
        () =>
          inTransaction(orm, async (em) => {
            await insertTx(em, win);
            await insertLedger(em, {
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: win.id,
              direction: 'CREDIT',
              amount: '10.00',
              currency: 'BRL',
              balanceBefore: '100.00',
              balanceAfter: '110.00',
              walletVersion: 1,
            });
          }),
        { constraint: 'ux_ledger_wallet_version', code: SQLSTATE.unique },
      );
    });

    test('BET PROCESSED sem lançamento', async () => {
      const wallet = await open();
      await expectViolation(
        () =>
          inTransaction(orm, (em) => insertTx(em, txRow(wallet, { kind: 'BET', amount: '10.00' }))),
        { constraint: 'tg_wager_tx_has_entry', code: SQLSTATE.trigger },
      );
    });

    test('lançamento para LOSS, para transação REJECTED, com direção ou valor errados', async () => {
      const wallet = await open();
      const attempt = (tx: ReturnType<typeof txRow>, direction: string, amount: string) =>
        inTransaction(orm, async (em) => {
          await insertTx(em, tx);
          const after = direction === 'CREDIT' ? '110.00' : '90.00';
          await insertLedger(em, {
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: tx.id,
            direction,
            amount,
            currency: 'BRL',
            balanceBefore: '100.00',
            balanceAfter: after,
            walletVersion: 2,
          });
          await em.execute('update wallets set balance = ?, version = 2 where id = ?', [
            after,
            wallet.id,
          ]);
        });
      const violation = { constraint: 'tg_ledger_consistency', code: SQLSTATE.trigger };

      await expectViolation(
        () => attempt(txRow(wallet, { kind: 'LOSS', amount: '10.00' }), 'DEBIT', '10.00'),
        violation,
      );
      await expectViolation(
        () =>
          attempt(
            txRow(wallet, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' }),
            'DEBIT',
            '10.00',
          ),
        violation,
      );
      await expectViolation(
        () => attempt(txRow(wallet, { kind: 'BET', amount: '10.00' }), 'CREDIT', '10.00'),
        violation,
      );
      await expectViolation(
        () => attempt(txRow(wallet, { kind: 'WIN', amount: '20.00' }), 'CREDIT', '10.00'),
        violation,
      );
    });

    test('fluxo válido completo passa: abertura, BET, WIN, LOSS, REFUND e ROLLBACK', async () => {
      const wallet = await open('100.00');
      const bet = await applyMovement(orm, wallet, {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '40.00',
      });
      const win = await applyMovement(orm, bet.wallet, {
        kind: 'WIN',
        direction: 'CREDIT',
        amount: '15.50',
      });
      await inTransaction(orm, (em) =>
        insertTx(em, txRow(win.wallet, { kind: 'LOSS', amount: '0.00' })),
      );
      const bet2 = await applyMovement(orm, win.wallet, {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '20.00',
      });
      const refund = await applyMovement(orm, bet2.wallet, {
        kind: 'REFUND',
        direction: 'CREDIT',
        amount: '20.00',
        reference: { id: bet2.tx.id, externalTransactionId: bet2.tx.externalTransactionId },
      });
      const rollbackWin = await applyMovement(orm, refund.wallet, {
        kind: 'ROLLBACK',
        direction: 'DEBIT',
        amount: '15.50',
        reference: { id: win.tx.id, externalTransactionId: win.tx.externalTransactionId },
      });
      expect(rollbackWin.wallet).toMatchObject({ balance: '60.00', version: 6 });
    });
  });
});
