import {
  type CreateWagerTransactionProps,
  computeInboxPayloadHash,
  INTERNAL_PROVIDER_ID,
  InboxMessage,
  InvalidFieldError,
  InvalidTransactionKindError,
  Money,
  type MoneyProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain';
import { ExternalTransactionConflictError, WalletNotFoundError } from '../errors';
import {
  type Clock,
  type IdGenerator,
  type TransactionScope,
  UniqueConstraint,
  UniqueViolationError,
  type UnitOfWork,
} from '../ports';
import { normalizeUuid } from '../shared/identifiers';
import { applyWager } from './apply-wager';
import { toOutcome, type WagerTransactionOutcome } from './views';

/** Comando independente de transporte: HTTP e consumer SQS montam o mesmo objeto. */
export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  /** Propagado para os eventos da outbox. */
  correlationId: string;
  causationId?: string | undefined;
}

/**
 * Entrega vinda de uma fila. Com ela, o use case consulta e grava a inbox
 * `(consumerName, messageId)` na mesma transação SQL do efeito (ARCHITECTURE §9).
 */
export interface MessageDelivery {
  /** Consumidor lógico: o mesmo em todas as instâncias (não identifica o processo). */
  consumerName: string;
  /** Id do envelope, estável entre reenvios do produtor (não o MessageId do SQS). */
  messageId: string;
  /** `type` do envelope; entra no hash do conteúdo da mensagem. */
  messageType: string;
  receivedAt: Date;
}

/** Uma tentativa extra cobre a corrida residual; uma segunda colisão seguida não é corrida. */
const MAX_ATTEMPTS = 2;

/** Colisões que significam "outra requisição gravou primeiro": reler resolve (replay ou 409). */
const RESIDUAL_RACE_CONSTRAINTS: ReadonlySet<string> = new Set([
  UniqueConstraint.IdempotencyKey,
  UniqueConstraint.ProviderExternalId,
  UniqueConstraint.ReversalOnce,
  // a mesma mensagem processada por dois consumers ao mesmo tempo: a segunda vira reentrega
  UniqueConstraint.InboxMessage,
]);

/**
 * Processa BET, WIN, LOSS, REFUND e ROLLBACK com idempotência persistente.
 *
 * Fluxo numa transação SQL (READ COMMITTED):
 *  1. busca pela Idempotency-Key, sem lock: existe → replay (hash igual) ou conflito
 *  2. `SELECT … FOR UPDATE` na wallet (ponto de serialização; não existe → 404)
 *  3. busca pela key de novo, agora serializado pela wallet → replay ou conflito
 *  4. `(providerId, externalTransactionId)` já usado com outra key → conflito
 *  5. referência + regra de negócio no domínio; transação, saldo, ledger e outbox gravados juntos
 * Uma violação de unicidade no COMMIT (corrida entre wallets diferentes com a mesma key) desfaz
 * tudo e o fluxo roda de novo uma vez, respondendo replay ou conflito.
 *
 * Com `delivery` (consumer SQS), antes de tudo a inbox: mensagem já registrada → devolve o
 * resultado original sem efeito (`duplicateDelivery`); senão o fluxo acima roda e, em todo
 * desfecho confirmado (inclusive replay), a inbox é gravada no mesmo COMMIT. Erro lançado faz
 * rollback e não deixa inbox: a mensagem pode ser tentada de novo.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    command: ProcessWagerTransactionCommand,
    delivery?: MessageDelivery,
  ): Promise<WagerTransactionOutcome> {
    const props = parseCommand(command);
    const build = () =>
      WagerTransaction.create({
        ...props,
        id: this.ids.newId(),
        correlationId: command.correlationId,
        now: this.clock.now(),
      });
    // Valida o payload inteiro antes de abrir transação: erro aqui não toca o banco.
    let candidate = build();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.uow.run((scope) =>
          delivery
            ? this.processDelivery(scope, candidate, command, delivery)
            : this.process(scope, candidate, command),
        );
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isResidualRace(error)) {
          throw error;
        }
        // A tentativa anterior mudou o estado em memória do candidato: recomeça do zero.
        candidate = build();
      }
    }
  }

  private async processDelivery(
    scope: TransactionScope,
    candidate: WagerTransaction,
    command: ProcessWagerTransactionCommand,
    delivery: MessageDelivery,
  ): Promise<WagerTransactionOutcome> {
    const contentHash = computeInboxPayloadHash({
      messageType: delivery.messageType,
      idempotencyKey: candidate.idempotencyKey,
      wagerPayloadHash: candidate.payloadHash,
    });
    const seen = await scope.inbox.find(delivery.consumerName, delivery.messageId);
    if (seen) {
      seen.assertRedeliveryOf(contentHash);
      // inbox e transação são gravadas no mesmo COMMIT, e transação não é apagada
      const original = await scope.transactions.findByIdempotencyKey(candidate.idempotencyKey);
      if (!original) {
        throw new Error(
          `Inbox ${delivery.consumerName}/${delivery.messageId} sem a transação correspondente`,
        );
      }
      return { ...replay(original, candidate), duplicateDelivery: true };
    }

    const outcome = await this.process(scope, candidate, command);
    const inbox = InboxMessage.receive({
      consumerName: delivery.consumerName,
      messageId: delivery.messageId,
      payloadHash: contentHash,
      receivedAt: delivery.receivedAt,
    });
    inbox.markProcessed(this.clock.now());
    await scope.inbox.add(inbox);
    return outcome;
  }

  private async process(
    scope: TransactionScope,
    candidate: WagerTransaction,
    command: ProcessWagerTransactionCommand,
  ): Promise<WagerTransactionOutcome> {
    // Estado terminal não muda (trigger de guarda) e o snapshot fica fixo: replay sem lock.
    const early = await scope.transactions.findByIdempotencyKey(candidate.idempotencyKey);
    if (early) {
      return replay(early, candidate);
    }

    const wallet = await scope.wallets.findByIdForUpdate(candidate.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(candidate.walletId);
    }

    // Quem esperou o lock pode encontrar agora a transação que o dono do lock confirmou.
    const existing = await scope.transactions.findByIdempotencyKey(candidate.idempotencyKey);
    if (existing) {
      return replay(existing, candidate);
    }
    const sameExternalId = await scope.transactions.findByProviderAndExternalId(
      candidate.providerId,
      candidate.externalTransactionId,
    );
    if (sameExternalId) {
      throw new ExternalTransactionConflictError(
        candidate.providerId,
        candidate.externalTransactionId,
      );
    }

    await applyWager(scope, this.ids, {
      wallet,
      transaction: candidate,
      isNew: true,
      now: candidate.createdAt,
      correlation: { correlationId: command.correlationId, causationId: command.causationId },
    });
    return toOutcome(candidate, false);
  }
}

/** Mesma key: hash igual é replay do resultado original; hash diferente é conflito. */
function replay(existing: WagerTransaction, candidate: WagerTransaction): WagerTransactionOutcome {
  existing.assertReplayOf(candidate.payloadHash);
  return toOutcome(existing, true);
}

function isResidualRace(error: unknown): boolean {
  return error instanceof UniqueViolationError && RESIDUAL_RACE_CONSTRAINTS.has(error.constraint);
}

const SUBMITTABLE_KINDS: readonly string[] = Object.values(WagerTransactionKind).filter(
  (kind) => kind !== WagerTransactionKind.Opening,
);

/** Normalização compartilhada por HTTP e SQS; o restante da validação fica no domínio. */
function parseCommand(
  command: ProcessWagerTransactionCommand,
): Omit<CreateWagerTransactionProps, 'id' | 'now'> {
  if (command.providerId === INTERNAL_PROVIDER_ID) {
    throw new InvalidFieldError(
      'providerId',
      `"${INTERNAL_PROVIDER_ID}" é reservado para transações internas`,
    );
  }
  if (!SUBMITTABLE_KINDS.includes(command.kind)) {
    throw new InvalidTransactionKindError(String(command.kind));
  }
  return {
    idempotencyKey: command.idempotencyKey,
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: normalizeUuid('playerId', command.playerId),
    walletId: normalizeUuid('walletId', command.walletId),
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind as WagerTransactionKind,
    money: Money.from(command.money),
    referenceExternalTransactionId: command.referenceExternalTransactionId ?? undefined,
  };
}
