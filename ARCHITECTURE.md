# ARCHITECTURE.md

## 1. Visão geral

Um único serviço NestJS (TypeScript estrito, rodando em Bun) organizado em **arquitetura hexagonal**.
A mesma imagem roda em vários **papéis**, escolhidos por variável de ambiente:

| Papel (`ROLE`) | Responsabilidade |
|---|---|
| `api` | HTTP: wallets, submissão de transações, consultas, reconciliação, health |
| `consumer` | Consome `wager-transactions.fifo` e chama o mesmo use case do HTTP |
| `outbox` | Publica eventos pendentes da tabela `outbox_messages` |
| `pending-ref` | Reprocessa transações `PENDING_REFERENCE` com backoff |

`ROLE=all` liga tudo (útil em dev). No docker compose rodamos **3 réplicas** para provar a correção com
múltiplas instâncias.

```
              HTTP  ─┐                            ┌─> wallets (FOR UPDATE)
                     ├─> ProcessWagerTransaction ─┼─> wager_transactions
SQS consumer ─inbox ─┘      (1 transação SQL)     ├─> wallet_ledger_entries
                                                  └─> outbox_messages ──> worker outbox ──> SQS (eventos)
```

## 2. Camadas

| Camada | Contém | Pode importar |
|---|---|---|
| `domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, `IntegrationEvent` e subclasses, erros de domínio, `FailureCode` | nada externo (só `decimal.js` e `node:crypto`, este apenas para o SHA-256 do payload) |
| `application` | use cases, ports (`WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`, `InboxRepository`, `OutboxRepository`, `UnitOfWork`, `Clock`, `IdGenerator`, `EventPublisher`) | `domain` |
| `infrastructure` | MikroORM (`EntitySchema` + mappers), tipo customizado de `Money`, repositórios, cliente SQS, métricas, logger | tudo |
| `interfaces` | controllers, DTOs/validação, consumer SQS, workers, health | `application` |

Por que `EntitySchema` + mappers em vez de decorators no domínio: o desafio proíbe o domínio de depender
do ORM, e o mapeamento explícito deixa claro onde `rehydrate` é chamado.

## 3. Dinheiro (`Money`)

- Domínio: `decimal.js`, imutável, escala fixa de 2 casas, moeda ISO-4217.
- Entrada aceita apenas `^\d+(\.\d{1,2})?$` (sem sinal, sem notação científica, sem vazio, no máximo 2 casas).
  Normaliza para 2 casas (`"25"` → `"25.00"`). Confirmado na fase 2 (detalhes na seção 14).
- Banco: `numeric(20,2)` + coluna `currency char(3)`. O driver `pg` devolve `numeric` como string; o tipo
  customizado `DecimalAmountType` mapeia `numeric(20,2)` ↔ string `"25.00"` e recusa `number` nos dois
  sentidos. Como um tipo do MikroORM enxerga uma coluna só, o `Money` (valor + moeda) é montado no mapper.
  Nunca passa por `number`.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`. O desafio roda só com `BRL`, mas o
  modelo é multi-moeda e isso é testado.

## 4. Concorrência

**Unidade de concorrência: `walletId`.** Estratégia: **lock pessimista por linha**.

1. `BEGIN`
2. `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`)
3. checa idempotência, resolve referência e aplica a regra de negócio no domínio
4. `UPDATE wallets SET balance = $novo, version = version + 1, updated_at = now() WHERE id = $1`
5. `INSERT` da transação, do ledger, do inbox e do outbox
6. `COMMIT`

Por que essa estratégia:

- Serializa só as operações **da mesma wallet**; wallets diferentes andam em paralelo, sem lock global.
- Funciona com N instâncias, porque o lock vive no Postgres e não no processo.
- É simples de explicar e testar. Com optimistic locking, uma wallet muito disputada geraria muitos retries.
- Rede de segurança no schema: `CHECK (balance >= 0)`. Mesmo um bug no código não deixa o saldo ficar negativo.
- `version` incrementa só quando o saldo muda (LOSS e REJECTED não incrementam).

**Ordem de lock:** sempre `wallets` antes de `wager_transactions`, para evitar deadlock entre o use case e
os workers.

## 5. Idempotência

- Header `Idempotency-Key` obrigatório. Padrão: `"{providerId}:{externalTransactionId}"`.
- `payloadHash` = SHA-256 (hex) do **JSON canônico** (chaves ordenadas recursivamente, sem espaços) dos
  campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
  money{amount,currency}, referenceExternalTransactionId`. O amount entra já normalizado. Header e
  metadados de transporte ficam de fora.
- No banco: `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`.
- Fluxo: depois do lock da wallet, busca pela key:
  - não existe → processa;
  - existe com o mesmo hash → **replay**: devolve o snapshot salvo (`status`, `balance_after`) com
    `idempotentReplay: true`;
  - existe com hash diferente → **conflito** (409), não é replay.
- Corrida residual (duas requisições sem wallet válida, por exemplo): a constraint única barra a segunda,
  que faz rollback, relê e responde replay ou conflito.
- Inbox do SQS: PK `(consumer_name, message_id)` na mesma transação.

## 6. Schema

Fonte da verdade: [`migrations/Migration20261106120000_wagering_schema.ts`](migrations/Migration20261106120000_wagering_schema.ts).
Tabelas `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`.
Dinheiro em `numeric(20,2)` + `char(3)`, ids `uuid`, horários `timestamptz`. Convenção de nomes: `pk_`,
`ux_` (único), `fk_`, `ck_` (CHECK), `ix_` (índice), `tg_` (trigger).

Garantias aplicadas no banco (restrição 9), cada uma coberta em `test/integration/schema-constraints.test.ts`:

| Garantia | Como |
|---|---|
| Saldo nunca negativo | `ck_wallets_balance_non_negative`, `ck_ledger_balances_non_negative`, `ck_wager_tx_snapshot_non_negative` |
| Uma wallet por player + moeda | `ux_wallets_player_currency` |
| Idempotência | `ux_wager_tx_idempotency_key`, `ux_wager_tx_provider_external` |
| Uma abertura por wallet | `ck_wager_tx_opening` + `ck_wager_tx_opening_shape` (key `opening:{walletId}`, que é única) |
| Uma reversão `PROCESSED` por referência | índice único parcial `ux_wager_tx_reversal_once` + `ck_wager_tx_resolved_reference` (sem ele, um `NULL` escaparia do índice) |
| No máximo um lançamento por transação (logo, por wallet) | `ux_ledger_transaction` + FK composta `fk_ledger_transaction_wallet` |
| Aritmética do lançamento | `ck_ledger_arithmetic`, `ck_ledger_amount_positive` |
| Ledger imutável | `tg_ledger_append_only` (UPDATE/DELETE), `tg_ledger_no_truncate` |
| Moeda do lançamento = moeda da wallet | FK composta `fk_ledger_wallet_currency` |
| Reversão aponta para transação da mesma wallet | FK composta `fk_wager_tx_reference_same_wallet` |
| Máquina de estados da transação | CHECKs `ck_wager_tx_*` (`failure_code` ⇔ REJECTED/FAILED, `processed_at` ⇔ terminal, `next_attempt_at` ⇔ PENDING_REFERENCE…) + `tg_wager_tx_guard_update` (terminal não muda, campos de negócio imutáveis) |
| Transação não é apagada (REJECTED também é auditoria) | `tg_wager_tx_no_delete`, `tg_wager_tx_no_truncate` |
| `version` sobe 1 só quando o saldo muda; UPDATE sobre leitura antiga falha | `tg_wallets_guard_update` |
| Saldo ↔ ledger ↔ transação consistentes no COMMIT | `ux_ledger_wallet_version`, `tg_ledger_consistency`, `tg_wallet_matches_ledger`, `tg_wager_tx_has_entry` (seção 15) |

Índices de acesso: `ix_wager_tx_pending_reference_due` (worker), `ix_outbox_due` (publisher) e
`ux_ledger_wallet_seq` (cursor do ledger por wallet; estável porque o lock da wallet serializa os inserts).

A transação `OPENING` usa `provider_id = 'internal'` e `idempotency_key = 'opening:{walletId}'`.
A API e a fila rejeitam `kind = OPENING`.

## 7. Regras de negócio e códigos de falha (rascunho)

| `failureCode` | Quando | Provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desistir |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK que deixaria saldo negativo | investigar (operacional) |
| `REFERENCE_NOT_FOUND` | referência não apareceu dentro do limite de tentativas | corrigir/reenviar |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/moeda/rodada | corrigir payload |
| `REFERENCE_INVALID_KIND` | REFUND→não-BET, ROLLBACK→LOSS/OPENING/ROLLBACK | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | referência REJECTED/FAILED | desistir |
| `ALREADY_REVERSED` | referência já revertida por esse tipo | desistir |
| `AMOUNT_MISMATCH` | valor da reversão diferente do da referência | corrigir payload |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir payload |
| `WALLET_PLAYER_MISMATCH` | wallet não pertence ao player | corrigir payload |
| `INFRA_PERMANENT_ERROR` | status `FAILED` (erro permanente de infraestrutura) | contatar suporte |

Transições do `WagerTransaction`:
`PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE` e
`PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`. Estados terminais não mudam.

## 8. Mapeamento HTTP (rascunho)

| Situação | Status |
|---|---|
| Processada | `201` (replay: `200` com `idempotentReplay: true`) |
| Aceita, aguardando referência (`PENDING_REFERENCE`) | `202` |
| Payload inválido / header ausente | `400` |
| Recurso não encontrado (wallet, transação) | `404` |
| Conflito de idempotência / wallet duplicada | `409` |
| Rejeitada por regra de negócio (corpo traz `failureCode`) | `422` |
| Falha transitória (Postgres/SQS fora, timeout de lock) | `503` com `Retry-After` |

O mesmo mapeamento vale para todos os endpoints.

## 9. Mensageria

**Consumer (`wager-transactions.fifo`):**
- Long polling. `MessageGroupId = walletId` (otimização de ordem), `MessageDeduplicationId = messageId`.
- Inbox na mesma transação SQL. **Ack (delete) só depois do commit.**
- Erro de negócio → ack (o resultado já está persistido como REJECTED).
- Erro transitório → sem ack; `ChangeMessageVisibility` com backoff.
- Erro permanente (mensagem malformada) → DLQ.
- Redrive policy `maxReceiveCount = 5` → `wager-transactions-dlq.fifo`.
- `SIGTERM`: para de buscar mensagens, termina as que estão em andamento e devolve a visibilidade das demais
  (`enableShutdownHooks`).

**Outbox publisher:**
- Loop: `SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at
  FOR UPDATE SKIP LOCKED LIMIT 50` → publica → `published_at = now()` → `COMMIT`.
- Vários publishers não pegam a mesma linha (`SKIP LOCKED`). Se o processo morre, a transação faz rollback,
  o lock é solto e outra instância assume.
- Garantia **at-least-once**: se publicar e morrer antes do commit, o evento sai duas vezes. O consumidor
  deduplica por `eventId`.
- Falha ao publicar → `scheduleRetry` (backoff exponencial com teto).
- Destino dos eventos: fila `wagering-events` *(o desafio não define, decisão nossa)*.

**Worker PENDING_REFERENCE:**
- Seleciona candidatos vencidos (`next_attempt_at <= now()`) sem lock e, para cada um, abre uma transação
  que trava a **wallet primeiro** e depois a transação (ordem de lock).
- Backoff exponencial: 1s, 2s, 4s… com teto de 60s; **máximo de 10 tentativas** *(a calibrar)*.
- Esgotado o limite → `REJECTED` / `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.

## 10. Observabilidade

- Logs JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
- Métricas Prometheus (`prom-client`) em `/metrics`: transações por status, duplicatas, retries, DLQ,
  conflitos/timeout de lock, outbox lag e latência de processamento.
- `GET /health/live` (processo vivo) e `GET /health/ready` (Postgres e SQS), sem autenticação.

## 11. Autenticação

Fora do escopo de pontuação. Entra um `AuthGuard` no-op como ponto de extensão, e documentamos aqui o
desenho que adotaríamos (Keycloak/OIDC, `client_credentials` por provedor, validando que o `providerId` do
token bate com o do payload).

## 12. Limitações e trade-offs conhecidos

- O `down` da migration de schema apaga o ledger. Existe porque o desafio exige migrations reversíveis;
  não é operação de produção.
- Os triggers diferidos de consistência (seção 15) custam duas ou três buscas por índice a cada commit
  que mexe em saldo.
- Como o banco não deixa saldo e ledger divergirem, um teste que precise simular divergência (reconciliação,
  fase 4) tem que desligar os triggers na sessão (`session_replication_role = replica`).

## 13. Decisões da fase 1 (scaffolding)

- **Versões instaladas**: NestJS 12, MikroORM 7, TypeScript 7, Bun 1.4. Todas são ESM.
- **Bun × decorators**: o Bun não garante `emitDecoratorMetadata`; toda DI usa `@Inject(Token)` explícito.
  Funcionou nos testes de integração (grafo Nest completo sobe e responde HTTP).
- **MikroORM**: `Migrator` como extensão, executado por `scripts/migrate.ts` (sem a CLI) e com
  `migrationsList` explícita, para não depender de glob de arquivos sob Bun. `EntitySchema` na fase 3.
  Não usamos `@mikro-orm/nestjs`: o provider de `MikroORM` é próprio (`DatabaseModule`).
- **Config**: `zod` valida o ambiente em `parseConfig`; falha na inicialização listando os campos inválidos.
- **Todos os papéis expõem HTTP** (health, futuramente `/metrics`), inclusive consumer/outbox/pending-ref.
  Isso mantém o processo vivo e permite liveness/readiness por papel.
- **Lint**: Biome.
- **LocalStack**: imagem fixada em `3.8` (comunitária, sem `LOCALSTACK_AUTH_TOKEN`). As filas são criadas por
  `docker/localstack/init-queues.sh`; o healthcheck só passa depois da última fila (`wagering-events`).
  `wager-transactions.fifo` tem redrive para a DLQ com `maxReceiveCount=5` e `ContentBasedDeduplication=false`.
- **Porta do Postgres no host**: 5433 (a 5432 costuma estar ocupada por um Postgres local). Dentro da rede do
  compose continua 5432.

## 14. Decisões da fase 2 (domínio)

Interpretações do enunciado e escolhas de modelagem, todas cobertas por testes em `test/unit/domain`.

1. **Uma reversão por referência, de qualquer tipo.** A regra 4 do desafio ("não revertida duas vezes pelo
   *mesmo tipo*") permitiria `REFUND` e depois `ROLLBACK` da mesma BET, creditando duas vezes. Adotamos:
   cada referência aceita no máximo uma reversão `PROCESSED` (REFUND ou ROLLBACK), senão `ALREADY_REVERSED`.
   `ROLLBACK` de um `REFUND` continua válido. O índice único parcial da fase 3 é
   `(reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.
2. **Valores.** `BET`, `WIN`, `REFUND`, `ROLLBACK` e `OPENING` exigem valor positivo (zero é erro de validação,
   HTTP 400). `LOSS` aceita `0.00`. Na fase 3, o schema deve refletir isso (por exemplo
   `CHECK (kind = 'LOSS' OR amount > 0)`).
3. **`Money`.**
   - Entrada: precisa ser `string`; número JSON é rejeitado. Aceita `^\d+(\.\d{1,2})?$` com até 18 dígitos
     inteiros (limite de `numeric(20,2)`). Mais de 2 casas é rejeitado, nunca arredondado, e não há
     multiplicação nem divisão, então não existe modo de arredondamento.
   - Moeda: `^[A-Z]{3}$`, sem normalizar minúsculas.
   - Operações: `subtract` e `negate` podem produzir negativo (a reconciliação usa isso); serializa como
     `"-5.00"`. Estouro do limite lança `InvalidMoneyError`. `equals` entre moedas diferentes é `false`;
     `add`, `subtract` e `isLessThan` lançam `CurrencyMismatchError`.
4. **Hash do payload.** SHA-256 hex (`node:crypto`, única exceção ao "só decimal.js" do domínio) do JSON
   canônico: chaves ordenadas recursivamente, sem espaços, `undefined`/`null` omitidos (HTTP e SQS geram o
   mesmo hash para "sem referência"), amount normalizado (`"25"` e `"25.00"` dão o mesmo hash). Campos
   hasheados: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money,
   referenceExternalTransactionId`. O `payloadHash` do `InboxMessage` é só uma string; a fase 6 decide o que
   hashear.
5. **Tempo e ids vêm de fora.** O domínio não chama `new Date()` nem gera UUID; factories e transições
   recebem `now` e ids por parâmetro (ports `Clock` e `IdGenerator` ficam na `application`).
6. **Assinaturas ajustadas em relação ao esqueleto do desafio.**
   - `Wallet.open` devolve `{ wallet, openingEntry? }`: saldo inicial > 0 gera CREDIT de `0.00` até o saldo,
     e `version` fica em 1. `WagerTransaction.opening(...)` cria a transação interna
     (`provider_id = 'internal'`, key `opening:{walletId}`).
   - Snapshot de saldo no replay (regra 7): `markProcessed(refId, balanceAfter, at)`,
     `reject(code, observedBalance, at)` e `markPendingReference(observedBalance, now)`. `processedAt` marca
     qualquer transição terminal.
   - Retry de `PENDING_REFERENCE`: `referenceAttempts` e `nextAttemptAt` vivem na transação;
     `scheduleReferenceRetry(now)` aplica backoff 1s, 2s, 4s… com teto de 60s. `PENDING_REFERENCE →
     PENDING_REFERENCE` só por esse método. O limite de tentativas (provisório: 10,
     `DEFAULT_MAX_REFERENCE_ATTEMPTS`) é calibrado na fase 7.
   - `WagerTransaction.assertReplayOf(hash)` lança `IdempotencyConflictError` quando a mesma key chega com
     payload diferente.
   - `fail()` só aceita `INFRA_PERMANENT_ERROR`; `reject()` aceita os demais códigos.
7. **Erros com `category`** (`validation` → 400/DLQ, `business` → 422/ack, `conflict` → 409, `invariant` →
   500, erro de programação). `InvalidTransactionStateError` é `invariant`: transicionar estado terminal não
   é caminho de negócio.
8. **Regras de referência (`ReferenceRules`) e aplicação (`WagerPolicy`).** Funções puras: o use case resolve
   a referência por `(providerId, referenceExternalTransactionId)` e as reversões já `PROCESSED` dela, e a
   policy devolve `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`, deixando a transação no estado certo.
   Ordem de checagem: referência ausente → pendente; auto-referência → `REFERENCE_INVALID_KIND`; referência
   não terminal → pendente; `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`; tipo inválido →
   `REFERENCE_INVALID_KIND`; outro provedor/player/wallet/moeda/rodada → `REFERENCE_MISMATCH`; já revertida
   → `ALREADY_REVERSED`; valor diferente → `AMOUNT_MISMATCH`. Antes disso, a policy checa a wallet:
   `WALLET_PLAYER_MISMATCH` e `CURRENCY_MISMATCH` (rejeição auditável). Falta de saldo vira
   `INSUFFICIENT_FUNDS` na BET e `REVERSAL_INSUFFICIENT_FUNDS` no ROLLBACK. Esgotadas as tentativas de
   referência: `REFERENCE_NOT_FOUND`.
9. **Referência em WIN/LOSS é informativa**: é guardada e entra no hash, mas não é resolvida nem exigida
   (o desafio só diz que o WIN "pode referenciar" a BET). BET não aceita referência.
10. **Eventos.** `aggregateId` é a transação nos eventos de transação e a wallet no `WalletBalanceChanged`.
    `data` carrega só `MoneyProps` e é congelada. `WagerTransactionRejected` inclui `providerAction`
    (`give_up`, `fix_payload`, `investigate`, `contact_support`) derivada do `failureCode`.
    `OutboxMessage.enqueue` usa o `eventId` como id, grava `event.toJSON()` como payload e vence no instante do
    evento. Backoff de publicação: 1s × 2^(tentativas−1), teto de 60s, sem jitter.

## 15. Decisões da fase 3 (schema e persistência)

1. **Records + mappers.** O ORM mapeia classes de persistência planas (`entity-schemas.ts`), sem relações
   declaradas; `mappers.ts` converte para o domínio sempre via `rehydrate`. O domínio continua sem importar
   MikroORM.
2. **FKs `DEFERRABLE INITIALLY DEFERRED`.** No flush, o MikroORM faz todos os INSERTs antes dos UPDATEs e só
   ordena tabelas por relações declaradas. Com records planos, a ordem entre tabelas não é garantida, então
   as FKs são checadas no COMMIT. Nada inválido é confirmado.
3. **Consistência cruzada no COMMIT** (constraint triggers diferidos, independentes da ordem dos comandos):
   - `tg_ledger_consistency`: só há lançamento para transação PROCESSED que move saldo, com o mesmo valor e
     moeda e direção coerente com o kind (ROLLBACK é o inverso da referência); `balance_before` é o
     `balance_after` do lançamento anterior (versão − 1), ou 0.00 no primeiro; o último lançamento bate com
     a wallet.
   - `tg_wallet_matches_ledger`: saldo e `version` da wallet são os do último lançamento (sem lançamentos:
     0.00 e 1).
   - `tg_wager_tx_has_entry`: toda transação PROCESSED que move saldo tem lançamento.
   - Para isso, `WalletLedgerEntry` ganhou `walletVersion` (versão da wallet depois do lançamento; a
     abertura é 1). `UNIQUE (wallet_id, wallet_version)` faz colidir dois lançamentos calculados sobre a
     mesma leitura.
   - A reconciliação da fase 4 continua necessária como auditoria (soma de créditos − débitos).
4. **`balance_after_currency`.** O snapshot de saldo do replay é da wallet, e numa rejeição
   `CURRENCY_MISMATCH` a moeda da wallet difere da moeda da transação.
5. **Sem CHECK de ordem temporal** (`updated_at >= created_at` etc.): os horários vêm do relógio de
   instâncias diferentes, e uma diferença entre relógios derrubaria uma transação válida.
6. **Erros.** Triggers lançam SQLSTATE 23000 com `CONSTRAINT = nome do trigger`. A UnitOfWork traduz pelo
   SQLSTATE e pelo nome: 23505 → `UniqueViolationError(constraint)` (`conflict`); 40001, 40P01, 55P03 e
   falha de conexão → `TransientPersistenceError` (`transient`); demais 23xxx → `IntegrityViolationError`
   (`invariant`, bug). Erros de domínio passam intactos.
7. **UnitOfWork.** `orm.em.fork().transactional(...)` em **READ COMMITTED**: depois do `FOR UPDATE`, cada
   comando lê o último estado confirmado. Em REPEATABLE READ, o `FOR UPDATE` falharia com erro de
   serialização sempre que outra instância alterasse a wallet. Cada transação roda
   `SET LOCAL lock_timeout` (`DB_LOCK_TIMEOUT_MS`, padrão 5000); se estourar, vira erro transitório.
8. **Lock.** `findByIdForUpdate` usa `LockMode.PESSIMISTIC_WRITE` com `refresh: true` (o MikroORM vai ao
   banco, e os valores travados substituem os do identity map). `WalletRepository.save` exige que a wallet
   tenha sido travada (ou criada) na mesma UnitOfWork: read → calculate → update sem lock falha também no
   código (`RepositoryMisuseError`).
9. **CHECKs são avaliados em ordem alfabética** pelo Postgres: uma direção inválida no ledger aparece como
   `ck_ledger_arithmetic`, que também a cobre. `ck_ledger_direction` fica como documentação.
10. **Pendências para a fase 4.** Recusar `providerId = 'internal'` na borda (400), porque o schema reserva
    esse provedor para OPENING. Validar `playerId`/`walletId` como UUID e normalizar para minúsculas: o
    Postgres devolve UUID em minúsculas, e um UUID em maiúsculas viraria erro 22P02 (500) ou um falso
    `WALLET_PLAYER_MISMATCH`.
11. **Testes.** Integração usa o banco `wagering_test`, criado e migrado sob demanda
    (`test/support/database.ts`), separado do `wagering` do app. O ledger é append-only, então cada teste usa
    ids novos em vez de limpar tabelas. O teste de migrations roda num banco descartável. Todo teste de
    integração termina conferindo `wallet.balance == saldo reconstruído pelo ledger`.
