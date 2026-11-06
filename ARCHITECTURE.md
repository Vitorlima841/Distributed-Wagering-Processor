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

`ROLE=all` liga tudo (útil em dev). A correção com múltiplas instâncias é provada pela suíte de
concorrência, que sobe **3 processos reais** da aplicação contra o mesmo Postgres (seção 17). O docker
compose roda uma instância; um perfil com réplicas atrás de um balanceador, para demonstração manual,
fica para a fase 9.

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

### Por que a estratégia é correta

O que precisa valer, mesmo com N instâncias, retries e quedas: nada de lost update, de saldo negativo,
de débito ou crédito duplicado, nem de saldo e ledger divergentes; e o sistema não pode travar
(deadlock) nem serializar wallets diferentes.

1. **Exclusão mútua por wallet.** Todo caminho que muda o saldo ou as transações de uma wallet roda numa
   transação SQL que começa travando a linha dela (`FOR UPDATE`). O Postgres segura esse lock até o
   COMMIT ou ROLLBACK. Para uma mesma wallet, as seções críticas "ler saldo → decidir → gravar saldo,
   ledger, transação e outbox → COMMIT" acontecem uma de cada vez. O código não deixa gravar uma wallet
   sem esse lock (`RepositoryMisuseError`), e o banco recusa um UPDATE feito sobre uma leitura antiga
   (`tg_wallets_guard_update`).
2. **Quem pega o lock lê o saldo mais recente.** Em READ COMMITTED, quando o `FOR UPDATE` espera outra
   transação, o Postgres relê a linha depois do COMMIT dela e devolve a versão nova (não a da
   fotografia do início do comando). E cada comando seguinte tira uma fotografia nova, já depois do lock.
   Por isso o saldo lido é sempre o que o dono anterior gravou: não existe lost update. (Em REPEATABLE
   READ o mesmo cenário daria erro de serialização, seção 15.7.)
3. **A decisão usa um saldo que não muda até o COMMIT.** A BET sem saldo é rejeitada com o saldo real
   daquele instante; nada fica negativo. Rede de segurança: `CHECK (balance >= 0)`.
4. **Idempotência dentro do lock.** Requisições com a mesma key e o mesmo payload apontam para a mesma
   wallet, então disputam o mesmo lock. A segunda checagem da key, feita depois do lock, enxerga a
   transação que o dono anterior confirmou e devolve replay. O único caso que não passa pelo mesmo lock
   (mesma key em wallets diferentes, ou seja, payload diferente) é decidido pelo índice único e vira
   replay ou conflito. Mesmo com um bug no código, os índices únicos (`ux_wager_tx_idempotency_key`,
   `ux_wager_tx_provider_external`, `ux_wager_tx_reversal_once`, `ux_ledger_transaction`,
   `ux_ledger_wallet_version`) impedem que um segundo efeito seja confirmado.
5. **Tudo ou nada, inclusive numa queda.** Transação, saldo, ledger e outbox são confirmados no mesmo
   COMMIT. Se o processo morre antes, a conexão cai, o Postgres desfaz a transação e solta o lock. Se
   morre depois, o efeito está gravado, e o retry com a mesma key recebe o replay. Não existe janela
   em que metade do efeito fique visível.
6. **Sem deadlock.** Cada operação trava uma única wallet, e qualquer outra linha (a transação, no
   worker da fase 7) só é travada depois dela. Com uma ordem única não há ciclo de espera. A espera
   por uma entrada de índice único (mesma key em duas wallets) é de mão única; se o Postgres ainda
   assim detectar deadlock (40P01), vira erro transitório (503), nunca inconsistência.
7. **Sem lock global.** O lock é de uma linha. Wallets diferentes não disputam nada e andam em paralelo.
8. **N instâncias.** Lock e unicidade vivem no Postgres, não na memória do processo; cada instância é só
   mais um cliente. Uma instância morta não deixa lock para trás (seção 17).
9. **Espera limitada.** `lock_timeout` (padrão 5s) limita a espera por uma wallet disputada: estourou,
   a requisição desiste sem efeito e responde 503 com `Retry-After`, e o provedor repete com a mesma key.

Custos aceitos: uma wallet muito disputada processa uma transação por vez (o throughput dela é
1 / duração da transação); e o optimistic locking foi descartado porque, numa hot wallet, viraria uma
fila de retries. A suíte `test/concurrency` testa cada ponto acima com 3 processos reais (seção 17).

## 5. Idempotência

- Header `Idempotency-Key` obrigatório. Padrão: `"{providerId}:{externalTransactionId}"`.
- `payloadHash` = SHA-256 (hex) do **JSON canônico** (chaves ordenadas recursivamente, sem espaços) dos
  campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
  money{amount,currency}, referenceExternalTransactionId`. O amount entra já normalizado. Header e
  metadados de transporte ficam de fora.
- No banco: `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`.
- Fluxo (`ProcessWagerTransaction`, detalhes na seção 16):
  1. busca pela key **sem lock**: se existe, responde replay ou conflito sem travar a wallet (estado
     terminal não muda e o snapshot fica fixo);
  2. `FOR UPDATE` na wallet;
  3. busca pela key de novo, já serializado pela wallet (quem esperou o lock acha o que o dono do
     lock confirmou);
  4. key nova, mas `(providerId, externalTransactionId)` já usado com outra key → **409
     `EXTERNAL_TRANSACTION_CONFLICT`**, mesmo com payload igual (o header é a fonte da verdade).
  - Mesmo hash → **replay**: devolve o snapshot salvo (`status`, `balance_after`) com
    `idempotentReplay: true`. Hash diferente → **409 `IDEMPOTENCY_CONFLICT`**, não é replay.
- Corrida residual (mesma key em wallets diferentes, que não disputam o mesmo lock): a constraint
  única barra a segunda no flush, que faz rollback e roda o fluxo de novo **uma vez**; os passos 1 e
  3 então respondem replay ou conflito.
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
`ux_ledger_wallet_version` (cursor do ledger por wallet: `wallet_version` é contígua e só cresce,
porque o lock da wallet serializa os lançamentos). `ux_ledger_wallet_seq` fica como ordem global de
inserção.

A transação `OPENING` usa `provider_id = 'internal'` e `idempotency_key = 'opening:{walletId}'`.
A API e a fila rejeitam `kind = OPENING`.

## 7. Regras de negócio e códigos de falha

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

## 8. Mapeamento HTTP

| Situação | Status | `error.code` / corpo |
|---|---|---|
| Processada | `201` (replay: `200` com `idempotentReplay: true`) | `{ transactionId, status, balance, idempotentReplay }` |
| Aceita, aguardando referência (`PENDING_REFERENCE`) | `202` (replay também `202`) | idem |
| Rejeitada por regra de negócio (persistida como REJECTED) | `422` (replay também `422`) | idem + `failureCode`, `providerAction` |
| Payload inválido / header ausente / cursor ou limit inválido | `400` | `INVALID_REQUEST` (com `details`), `INVALID_MONEY`, `INVALID_FIELD`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_CURSOR`… |
| Recurso não encontrado | `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| Conflito | `409` | `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS` (com `walletId`) |
| Falha transitória (lock timeout, conexão) | `503` + `Retry-After: 1` | `LOCK_TIMEOUT`, `LOCK_CONFLICT`, `DATABASE_UNAVAILABLE` (`retryable: true`) |
| Erro de programação / desconhecido | `500` | `INTERNAL_ERROR`, mensagem genérica |

Erros usam um envelope único em todos os endpoints (filtro global `HttpErrorFilter`):
`{ error: { code, category, message, retryable, details? }, correlationId }`. A categoria vem de
`classifyError` (application), que o consumer SQS da fase 6 reutiliza para decidir ack / retry / DLQ.
O replay de uma transação que estava PENDING_REFERENCE e já foi resolvida devolve o **estado atual**
(por exemplo, `200` PROCESSED com o saldo da resolução).

## 9. Mensageria

**Consumer (`wager-transactions.fifo`)**, detalhes na seção 18:
- Long polling (10s, até 10 mensagens). `MessageGroupId = walletId` (otimização de ordem),
  `MessageDeduplicationId = messageId`. Grupos em paralelo; mensagens do mesmo grupo em ordem.
- Chama o mesmo `ProcessWagerTransaction` do HTTP, com a entrega `(consumerName, messageId)`: a inbox
  é consultada e gravada na mesma transação SQL do efeito. **Ack (DeleteMessage) só depois que o use
  case volta, ou seja, depois do COMMIT.**
- Resultado de negócio (PROCESSED, REJECTED, PENDING_REFERENCE, replay, reentrega) → ack.
- Erro transitório (lock timeout, deadlock, banco fora, corrida de unicidade) e erro interno → sem ack;
  `ChangeMessageVisibility` = min(2s × 2^(n−1), 60s), com n = `ApproximateReceiveCount`.
- Erro permanente (mensagem malformada, validação, conflito, wallet inexistente) → DLQ na hora, com o
  motivo nos atributos.
- Redrive policy `maxReceiveCount = 5` → `wager-transactions-dlq.fifo` (cerca de 1 min de tentativas).
- `SIGTERM`: não busca mais, termina a mensagem em andamento de cada grupo e devolve as demais com
  visibilidade 0 (`enableShutdownHooks`).

**Outbox publisher** (papel `outbox`, detalhes na seção 19):
- Um ciclo = uma transação: `SELECT ... WHERE published_at IS NULL AND next_attempt_at <= $agora
  ORDER BY next_attempt_at, id LIMIT 50 FOR UPDATE SKIP LOCKED` → `SendMessageBatch` (lotes de 10) →
  `markPublished` nas aceitas e `scheduleRetry` nas demais → `COMMIT`.
- Só enxerga linhas confirmadas (READ COMMITTED): **nenhum evento sai antes do COMMIT** da transação
  financeira que o gravou.
- Vários publishers não pegam a mesma linha (`SKIP LOCKED`: a linha travada é pulada, não esperada).
  Se o processo morre, a transação faz rollback, o lock é solto e outra instância assume.
- Garantia **at-least-once**: se publicar e morrer antes do COMMIT, o evento sai duas vezes, idêntico.
  O consumidor deduplica por `eventId` (no corpo e no atributo `event-id`).
- Falha ao publicar → `scheduleRetry`: 1s, 2s, 4s… teto de 60s, **sem limite de tentativas**
  (desistir seria perder um evento confirmado).
- Destino: fila standard `wagering-events` *(o desafio não define, decisão nossa)*.

**Worker PENDING_REFERENCE** (papel `pending-ref`, detalhes na seção 19):
- Seleciona candidatos vencidos sem lock e, para cada um, abre uma transação que trava a **wallet
  primeiro** e depois a transação (ordem de lock); confere de novo se ainda está vencida e chama o
  mesmo núcleo do use case (`applyWager`).
- Backoff exponencial: 1s, 2s, 4s… com teto de 60s; **10 tentativas** (rejeição cerca de 5 min depois
  da chegada).
- Esgotado o limite → `REJECTED` / `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.

## 10. Observabilidade

- Logs JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
- Métricas Prometheus (`prom-client`) em `/metrics`: transações por status, duplicatas, retries, DLQ,
  conflitos/timeout de lock, outbox lag e latência de processamento.
- `GET /health/live` (processo vivo) e `GET /health/ready` (Postgres e SQS), sem autenticação.

## 11. Autenticação

Fora do escopo de pontuação. O ponto de extensão é o `ProviderAuthGuard` no-op
(`src/interfaces/http/provider-auth.guard.ts`), aplicado aos controllers de negócio; health fica fora.
Desenho que adotaríamos: Keycloak/OIDC, `client_credentials` por provedor; o guard valida o JWT
(JWKS, `iss`, `aud`, `exp`), extrai o `providerId` de uma claim e exige que ele bata com o do corpo
(`POST /wagering/transactions`) ou do path (`GET /providers/:providerId/...`), senão 403. Rotas de
wallet e reconciliação exigiriam um papel de backoffice.

## 12. Limitações e trade-offs conhecidos

- O `down` da migration de schema apaga o ledger. Existe porque o desafio exige migrations reversíveis;
  não é operação de produção.
- Os triggers diferidos de consistência (seção 15) custam duas ou três buscas por índice a cada commit
  que mexe em saldo.
- Como o banco não deixa saldo e ledger divergirem, um teste que precise simular divergência (reconciliação,
  fase 4) tem que desligar os triggers na sessão (`session_replication_role = replica`, exige superusuário).
  Essas wallets ficam adulteradas para sempre no banco `wagering_test` (ledger append-only) e são
  excluídas da checagem final do teste.
- O teste de "falha no meio do flush" depende da ordem em que o MikroORM envia os INSERTs (hoje a
  outbox antes de `wager_transactions`). Se a ordem mudar, o teste falha com SQLSTATE `P0002` em vez
  de passar em silêncio, e o ponto de injeção precisa ser ajustado.
- Wallet inexistente no `POST /wagering/transactions` responde 404 sem gravar nada: a FK
  `fk_wager_tx_wallet` não deixa persistir uma transação auditável sem wallet.
- Uma instância **congelada** (não morta) no meio de uma transação, ou separada do banco por uma
  partição de rede sem FIN/RST, segura o lock daquela wallet. Desde a fase 7, a UnitOfWork roda
  `SET LOCAL idle_in_transaction_session_timeout` (`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, padrão 30s):
  parada entre dois comandos, a sessão é derrubada pelo Postgres e o lock é solto. Uma instância
  congelada **no meio de um comando** (raro: os comandos são curtos) ainda depende do keepalive TCP.
  A correção não é afetada: sem COMMIT, nada é confirmado.
- **Consumer SQS** (seção 18):
  - Mensagens que estavam com uma instância morta sem aviso (SIGKILL) só voltam depois da visibilidade
    (30s). A correção não muda: a reentrega cai na inbox.
  - A visibilidade não é estendida durante o processamento (sem heartbeat). Se um lote demorar mais que
    30s (muitas mensagens do mesmo grupo esperando uma wallet disputada), a mensagem volta para a fila
    ainda em processamento e outra instância pode pegá-la. Inbox e idempotência impedem o segundo
    efeito; o custo é trabalho repetido.
  - Um Postgres fora do ar por mais de ~1 min manda para a DLQ as mensagens que já tinham sido
    recebidas (5 tentativas). O loop pausa para não gastar tentativas das que ainda não recebeu.
    Reprocessar da DLQ é seguro.
  - O status `FAILED` existe no modelo, no schema e no mapeamento HTTP, mas nada o produz ainda: quem
    desiste é a DLQ, e a key fica livre para reprocessar depois da correção.
  - O teste com SIGTERM real num processo só roda em Linux/macOS; no Windows ele é pulado (e o README
    mostra como rodá-lo num container).
- **Outbox e PENDING_REFERENCE** (seção 19):
  - A fila de eventos é standard: sem ordem entre eventos e com cópias possíveis. Quem precisa de ordem
    por wallet usa o `walletVersion` do `WalletBalanceChanged`.
  - O publisher segura os locks do lote durante a chamada ao SQS (até `OUTBOX_PUBLISH_TIMEOUT_MS`).
    Só publishers disputam essas linhas, e eles as pulam; o custo é uma transação aberta pelo tempo
    da chamada.
  - Um evento que o SQS recusa sempre (ex.: maior que 256 KB, longe do tamanho dos envelopes atuais)
    fica em retry a cada 60s para sempre, com log `warn`; a métrica entra na fase 8.
  - Uma reversão rejeitada com `REFERENCE_NOT_FOUND` é terminal: se a referência chegar depois, a
    reversão não volta sozinha, e o provedor precisa reenviá-la com outro id (`fix_payload`).
  - O worker não é acordado pela chegada da referência: a reversão espera a próxima tentativa
    agendada (até 60s depois das primeiras tentativas).
  - Transações gravadas antes da migration da fase 7 não têm `correlation_id`; os eventos do worker
    para elas usam o id da transação como correlação.

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
   hashear (decidido na seção 18.2).
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
     `DEFAULT_MAX_REFERENCE_ATTEMPTS`) foi confirmado na fase 7 (seção 19.3).
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

## 16. Decisões da fase 4 (use cases e API HTTP)

1. **Use cases puros na `application`** (`ProcessWagerTransaction`, `CreateWallet`, `GetWallet`,
   `ListWalletLedger`, `GetWagerTransaction`, `ReconcileWallet`), sem decorators do Nest; o
   `UseCasesModule` os liga aos ports por `useFactory`. Novos ports: `Clock`, `IdGenerator` (UUIDv7 via
   `Bun.randomUUIDv7()`, ordenado no tempo), `ReconciliationReader` e `ReconciliationMonitor`.
2. **Rejeição de negócio é resultado, não exceção.** Se fosse exceção, a UnitOfWork faria rollback e o
   REJECTED não ficaria auditado. O use case devolve `{ transactionId, status, balance, failureCode?,
   providerAction?, idempotentReplay }` e quem decide o status HTTP é a borda.
3. **Núcleo compartilhado `applyWager`** (`src/application/wagering/apply-wager.ts`): resolve a
   referência, aplica a `WagerPolicy` e registra transação, saldo, ledger e outbox no mesmo
   `TransactionScope`. O worker de PENDING_REFERENCE (fase 7) reutiliza com `isNew: false`.
   - A linha da referência não é travada: uma referência válida é da mesma wallet, e toda mudança em
     transações de uma wallet exige o lock dela. `ux_wager_tx_reversal_once` é a rede de segurança.
   - Auto-referência (`referenceExternalTransactionId == externalTransactionId`) é rejeitada na hora
     com `REFERENCE_INVALID_KIND`, em vez de esperar por si mesma como PENDING_REFERENCE.
4. **Eventos por desfecho:** PROCESSED → `WagerTransactionProcessed` (+ `WalletBalanceChanged` se houve
   lançamento); REJECTED → `WagerTransactionRejected`; entrada em PENDING_REFERENCE →
   `WagerTransactionPendingReference` (um retry sem sucesso do worker não repete o evento). A abertura da
   wallet com saldo > 0 emite `WagerTransactionProcessed` + `WalletBalanceChanged`: toda transação
   PROCESSED gera Processed, e todo lançamento gera BalanceChanged. Todos levam o `correlationId` da
   requisição (`X-Correlation-Id` do cliente, se válido, ou um id novo, devolvido no header).
5. **Normalização compartilhada por HTTP e SQS** (resolve a pendência §15.10): `playerId`/`walletId`
   validados como UUID e convertidos para minúsculas antes do hash; `providerId = 'internal'` e
   `kind = OPENING` dão 400. O DTO HTTP (zod) só checa forma: dinheiro como `string` (número JSON é
   400), textos até 255 caracteres, campos desconhecidos ignorados.
6. **Wallet duplicada:** decidida por `ux_wallets_player_currency`, sem leitura prévia. O 409 traz o
   `walletId` existente, para o cliente se recuperar de um retry de criação.
7. **Ledger paginado por chave em `wallet_version`**, do mais antigo ao mais novo; `limit` padrão 50,
   máximo 200. O cursor é opaco (base64url de `{ v, w, after }`) e amarrado à wallet: cursor de outra
   wallet, adulterado ou malformado dá 400 `INVALID_CURSOR`. Como a versão é contígua e só cresce,
   lançamentos novos durante a paginação não repetem nem pulam linhas.
8. **Reconciliação** numa única consulta SQL (um snapshot só em READ COMMITTED, sem travar a wallet):
   saldo, soma de CREDIT, soma de DEBIT e contagem. `calculated = créditos − débitos` e `difference =
   stored − calculated` em `Money` (podem ser negativos). Divergência vai para a resposta
   (`consistent: false`) e para o `ReconciliationMonitor` (log `warn` com wallet, diferença e
   contagem; métrica na fase 8). Nunca corrige nada.
9. **Sem retry interno de erro transitório:** lock timeout ou conexão perdida viram 503 com
   `Retry-After: 1`; o provedor repete com a mesma key. O único retry interno é o da corrida residual de
   unicidade (seção 5), limitado a uma tentativa extra.
10. **Logs de erro sem dados financeiros:** para erros do banco/driver, o filtro loga só nome, SQLSTATE
    e constraint (a mensagem do driver traz o SQL com os parâmetros).
11. **`POST /wagering/transactions` envia a resposta no próprio handler** (`@Res()`): o status depende do
    resultado, e o Nest sobrescreveria um `res.status()` com o código fixo da rota.
12. **Testes da fase** (`test/integration/http`, app Nest real numa porta aleatória contra o Postgres):
    cada regra de negócio, replay e conflito, duas corridas determinísticas (sincronizadas por
    `pg_stat_activity`, sem sleeps fixos), falha injetada no Postgres no meio do flush e no COMMIT
    (triggers temporários que só disparam para operações marcadas) e 503 por `lock_timeout` com a wallet
    travada por outra conexão. Todos terminam com `wallet.balance == saldo reconstruído pelo ledger`.

## 17. Decisões da fase 5 (concorrência e múltiplas instâncias)

1. **Instâncias são processos reais.** `test/support/cluster.ts` sobe, por arquivo de teste, 3 processos
   `bun src/main.ts` (`ROLE=api`) contra o banco `wagering_test`. Cada um tem o seu grafo Nest, o seu
   pool e o seu gerador de ids: o único estado compartilhado é o Postgres.
   - Porta efêmera (`PORT=0`): a instância só conta como pronta quando o log `application started`
     informa a porta real. Nenhum sleep.
   - `application_name` próprio por instância (`<cluster>-<n>-g<geração>`), visível no
     `pg_stat_activity`.
   - Queda = `SIGKILL` (TerminateProcess no Windows), sem shutdown gracioso. Reinício = processo novo,
     com outra porta e outro `application_name`.
   - Não usamos réplicas do docker compose: exigiriam rebuild da imagem e um balanceador, e o teste não
     controlaria qual instância cai nem quando.
2. **Simultaneidade comprovada por uma barreira no Postgres** (`fireThroughWalletLock`): uma conexão do
   teste trava a wallet (`FOR UPDATE`), as requisições saem pelas 3 instâncias, e o lock só é solto
   quando o `pg_stat_activity` mostra **todas** esperando por ele, agrupadas por instância. O teste
   afirma, por exemplo, que as 50 cópias da mesma aposta estavam ao mesmo tempo no lock, vindas dos 3
   processos. Variantes em rajada, sem barreira, cobrem as ordens em que parte das requisições cai na
   checagem de idempotência sem lock.
3. **Asserções independentes da ordem.** A ordem em que o Postgres entrega o lock varia. Os testes
   afirmam o que vale para qualquer ordem: um único efeito por key; saldo final = abertura + créditos −
   débitos das transações aplicadas; cada rejeição justificada pelo saldo devolvido naquele instante;
   e o saldo devolvido igual ao `balance_after` do próprio lançamento.
4. **Checagem final ampliada** (`expectConsistentWallets`, depois de cada teste): além de
   `wallet.balance == saldo reconstruído pelo ledger`, confere a sequência do ledger (versões contíguas,
   `balance_before` = `balance_after` anterior, nenhum saldo intermediário negativo, wallet na versão do
   último lançamento), um lançamento por transação que move saldo, os eventos exatos de cada desfecho
   na outbox e nenhum evento de transação que não existe.
5. **Configuração nova:** `PORT=0` aceito; `DB_POOL_MAX` (padrão 10); `DB_APPLICATION_NAME` (padrão
   `wagering-<ROLE>`, repassado ao `pg`, já que o MikroORM ignora parâmetros na `clientUrl`). Nos
   testes, cada instância usa pool 20 (as 50 requisições presas no lock precisam de conexão; 3 × 20
   cabem nas 100 do Postgres) e `DB_LOCK_TIMEOUT_MS=20000`, para uma máquina lenta não responder 503
   com a barreira fechada (o 503 por `lock_timeout` é coberto na integração).
6. **Quedas comprovadas** (`restart.test.ts`):
   - instância morta com 5 requisições paradas no lock: elas perdem a conexão; nada delas é gravado
     (nem transação nem evento, conferido pelo `correlationId`); as outras instâncias seguem; o retry
     aplica cada uma uma vez;
   - reinício completo (3 processos novos): o reenvio de todas as operações (201, 422 e 202) devolve
     replays idênticos (a idempotência está no banco, não na memória); a reconciliação dá
     `consistent: true`; operações novas seguem corretas;
   - queda das 3 instâncias num ponto arbitrário de uma carga de 120 operações: o retry de tudo aplica
     cada operação exatamente uma vez (as que tinham chegado ao COMMIT sem resposta voltam como
     replay); o saldo final é o esperado.
   - Comportamento observado no Postgres: a conexão de uma instância morta que **espera** um lock não
     percebe a queda enquanto espera. Ela recebe o lock na sua vez, falha ao responder e desfaz a
     transação em milissegundos. Já uma conexão que **segura** o lock percebe na hora (está lendo o
     socket). Por isso o teste espera essas conexões sumirem antes de conferir o banco.
7. **Resultado.** A suíte não revelou bug no código de processamento: as falhas durante o
   desenvolvimento foram de expectativa dos próprios testes. As mudanças de código foram as de
   configuração do item 5. Em 10 execuções seguidas, `bun run test:concurrency` passou nas 10
   (12 testes cada; de 12 a 15 s, com um ponto fora da curva de 25 s; a maior parte do tempo é para
   subir processos).
8. **Fora desta fase:** instância congelada segurando lock (seção 12); SIGTERM gracioso e worker morto
   entre commit e ack (feitos na fase 6, seção 18); dois publishers e reversão antes da referência
   (feitos na fase 7, seção 19).

## 18. Decisões da fase 6 (consumer SQS)

1. **O mesmo use case, com a entrega como parâmetro.** `ProcessWagerTransaction.execute(command,
   delivery?)`, com `delivery = { consumerName, messageId, messageType, receivedAt }`. Na mesma transação
   SQL:
   - inbox `(consumerName, messageId)` já existe → reentrega: devolve o resultado original sem efeito
     (`idempotentReplay: true`, `duplicateDelivery: true`);
   - senão, o fluxo do HTTP (seção 5) roda e, em **todo desfecho confirmado** (PROCESSED, REJECTED,
     PENDING_REFERENCE e também replay pela key), a inbox é gravada no mesmo COMMIT;
   - erro lançado faz rollback e não deixa inbox: a mensagem pode ser tentada de novo;
   - `pk_inbox_messages` entrou na lista de corrida residual: a mesma mensagem com dois consumers ao
     mesmo tempo → um confirma, o outro bate na PK, roda de novo uma vez e vira reentrega.
   - `consumerName` é o nome lógico (`SQS_CONSUMER_NAME`), o mesmo em todas as instâncias. O `messageId`
     é o do envelope, estável entre reenvios do produtor; o `MessageId` do SQS muda a cada envio e não
     serve para deduplicar.
2. **Hash da inbox:** SHA-256 (hex) do JSON canônico de `{ type, idempotencyKey, payloadHash }`, em que
   `payloadHash` é o da transação (amount normalizado: "25" e "25.00" dão o mesmo). `messageId`,
   `occurredAt` e metadados do SQS ficam de fora. O mesmo `messageId` com outro conteúdo é
   `INBOX_MESSAGE_CONFLICT` (conflito → DLQ), nunca uma segunda execução.
3. **Contrato da mensagem:** envelope da seção 10 do desafio; `data` tem a mesma forma do corpo do
   `POST /wagering/transactions` (schema compartilhado em `src/interfaces/contracts`), mais a
   `idempotencyKey`, obrigatória e com as regras do header. `messageId`: até 128 caracteres ASCII
   visíveis (como o `MessageDeduplicationId`). `correlationId` dos eventos: o do envelope, se vier num
   formato válido, senão o `messageId`; `causationId` = `messageId`.
4. **Decisão por mensagem** (`src/interfaces/sqs/consumer-decision.ts`, a partir de `classifyError`):

   | Situação | Decisão |
   |---|---|
   | PROCESSED, REJECTED, PENDING_REFERENCE, replay, reentrega | ack depois do COMMIT |
   | JSON inválido, tipo desconhecido, envelope ou campo inválido (`validation`) | DLQ na hora |
   | `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `INBOX_MESSAGE_CONFLICT` | DLQ na hora |
   | `WALLET_NOT_FOUND` | DLQ na hora |
   | `LOCK_TIMEOUT`, `LOCK_CONFLICT`, `DATABASE_UNAVAILABLE`, `CONCURRENT_CONFLICT` | retry com backoff |
   | erro interno ou desconhecido | retry com backoff (o redrive limita) |
   | erro de negócio lançado (o caminho normal devolve REJECTED) | ack |

   Conflitos e wallet inexistente vão direto para a DLQ: nada auditável pode ser gravado (a FK barra
   transação sem wallet), repetir não muda o resultado e, pela fila, não há resposta para o provedor
   ler, então um ack com log perderia a informação. Erro interno não é "permanente" por definição: pode
   ser uma falha passageira não mapeada; repete e, se persistir, o redrive leva à DLQ.
5. **Backoff pela contagem do SQS:** `min(base × 2^(n−1), máximo)` com n = `ApproximateReceiveCount`
   (padrão 2s e 60s, sem jitter, como o da outbox). A contagem é do SQS, não da memória do processo:
   vale para qualquer instância e sobrevive a reinícios. Com `maxReceiveCount = 5`, a mensagem tenta por
   cerca de 1 min (2 + 4 + 8 + 16 + 32 s) antes da DLQ. Se o SQS ou o banco estiverem fora do ar, o
   loop pausa (500 ms dobrando até 30 s) antes de buscar mais, para não gastar tentativas das mensagens
   que ainda não recebeu.
6. **DLQ na hora** = `SendMessage` para a DLQ (corpo intacto, mesmo grupo, atributos `failure-kind`,
   `failure-code`, `source-message-id`, `receive-count`) e depois `DeleteMessage`. Não é atômico: se o
   processo morrer entre os dois, a reentrega cai no mesmo erro e envia de novo com o mesmo
   `MessageDeduplicationId` (o `MessageId` do SQS, que não muda entre reentregas), e a dedup do FIFO
   descarta a cópia. O redrive nativo (tentativas esgotadas) não traz motivo; o log `message will be
   retried` tem o código do erro de cada tentativa. Para reprocessar da DLQ, reenviar o corpo com
   **outro** dedup id (a janela de 5 min do FIFO descartaria o mesmo): a inbox impede o efeito duplo.
7. **Ordem.** No mesmo lote, grupos rodam em paralelo e as mensagens de um grupo em sequência. Achado
   no LocalStack 3.8: devolver com visibilidade 0 a 2ª mensagem de um grupo enquanto a 1ª está em
   backoff faz a 2ª ser entregue antes. Por isso, quando uma mensagem vai para retry, as seguintes do
   mesmo grupo no lote voltam com o mesmo atraso. A ordem continua sendo otimização: fora de ordem, uma
   reversão vira PENDING_REFERENCE e a correção não muda.
8. **Shutdown.** `beforeApplicationShutdown` (antes de o ORM e o cliente SQS fecharem): não busca mais,
   termina a mensagem em andamento de cada grupo e devolve as que não começaram com visibilidade 0.
   **O long poll em andamento não é cancelado.** Achado nos testes: cancelado do lado do cliente, o
   LocalStack mantém a requisição aberta e entrega mensagens a ela; elas ficam invisíveis até o fim da
   visibilidade sem ninguém processar. O consumer espera o long poll terminar sozinho (por isso
   `SQS_WAIT_TIME_SECONDS` caiu para 10s) e devolve na hora o que ele trouxer. Prazo total
   `SQS_SHUTDOWN_TIMEOUT_MS` (15s); estourado, cancela o long poll e devolve também as em andamento (se
   uma delas ainda confirmar, a reentrega cai na inbox). `stop_grace_period: 30s` no compose.
9. **`FAILED` não é produzido nesta fase:** a DLQ é o registro da desistência, e a key fica livre para
   reprocessar depois que a causa for corrigida (FAILED seria terminal).
10. **Portas e adapters.** `WagerQueue` (receive, ack, retryAfter, deadLetter) é definida em
    `src/interfaces/sqs` e implementada por `SqsWagerQueue` (`src/infrastructure/messaging`), sobre um
    `SQSClient` por processo (`MessagingModule`, reaproveitado pelo publisher da fase 7). Com
    `SQS_ENDPOINT` definido, o SDK fala sempre com esse endpoint (não com o host da QueueUrl). O loop
    (`WagerMessageConsumer`) é uma classe pura, testada em unidade com uma fila em memória.
11. **Configuração nova:** `SQS_CONSUMER_NAME`, `SQS_WAIT_TIME_SECONDS` (10), `SQS_MAX_MESSAGES` (10),
    `SQS_VISIBILITY_TIMEOUT_S` (30), `SQS_RETRY_BASE_DELAY_S` (2), `SQS_RETRY_MAX_DELAY_S` (60),
    `SQS_SHUTDOWN_TIMEOUT_MS` (15000).
12. **Testes** (LocalStack e Postgres reais; todos terminam com `expectConsistentWallets`):
    - Cada arquivo cria as **próprias filas** (FIFO + DLQ com redrive 5, como o `init-queues.sh`):
      os testes não disputam mensagens entre si nem com o container `app` (`ROLE=all`). Pelo mesmo
      motivo, o teste de health (`ROLE=all`) agora usa filas próprias.
    - Um **proxy HTTP** na frente do LocalStack (`test/support/sqs-proxy.ts`) registra cada chamada
      (backoff de cada `ChangeMessageVisibility`, cada ack, cada recebimento com a contagem) e pode
      segurar uma operação. É assim que o teste mata o consumer depois do COMMIT e antes do ack, sem
      gancho de teste no código de produção.
    - `test/integration/sqs/inbox.test.ts`: atomicidade (falha injetada no COMMIT com transação, saldo,
      ledger, outbox e inbox escritos → nada fica), reentrega, `messageId` reutilizado, outra mensagem
      com a mesma key, inbox em REJECTED/PENDING_REFERENCE, rollback sem inbox e a mesma entrega em
      paralelo.
    - `consumer.test.ts`: ack depois do COMMIT com correlação nos eventos, REJECTED/PENDING_REFERENCE,
      HTTP e depois fila, reentrega fora da dedup do FIFO e duas instâncias com a mesma mensagem ao
      mesmo tempo (sincronizadas pelo lock da wallet).
    - `retry-and-dlq.test.ts`: backoff 1s, 2s, 4s observado; esgotamento → redrive nativo para a DLQ
      sem nada gravado e reprocessamento a partir da DLQ; oito tipos de erro permanente direto na DLQ
      com o motivo; INSUFFICIENT_FUNDS com ack.
    - `shutdown.test.ts`: `app.close()` (o caminho do SIGTERM) com uma mensagem parada no lock e outras
      atrás. O teste com SIGTERM real num processo é pulado no Windows; rodou e passou num container
      Linux (comando no README).
    - `test/concurrency/consumer-crash.test.ts`: consumer morto (SIGKILL) depois do COMMIT e antes do
      ack, outro processo recebe a reentrega (contagem 2) e não repete o efeito; três consumers em
      processos com 72 mensagens (duplicadas e reenviadas com outro `messageId`) → cada operação
      aplicada uma vez.
    - Os testes novos de SQS passaram 5 vezes seguidas (cerca de 34 s por execução).

## 19. Decisões da fase 7 (outbox publisher e worker de PENDING_REFERENCE)

1. **Publisher: uma transação por lote** (`PublishOutbox`, `src/application/messaging`).
   `claimDue` faz `FOR UPDATE SKIP LOCKED` pelo índice parcial `ix_outbox_due`, publica pelo port
   `EventPublisher` e grava `markPublished` / `scheduleRetry` antes do COMMIT.
   - **Por que segurar o lock durante a chamada ao SQS** (e não um lease com coluna `locked_until`):
     a recuperação de uma queda vem de graça (o rollback solta o lock, sem expiração a calibrar), sem
     migration nem estado extra. O custo, uma transação aberta pelo tempo da chamada, é limitado por
     `OUTBOX_PUBLISH_TIMEOUT_MS` (10s); só outros publishers disputam essas linhas, e eles pulam em vez
     de esperar.
   - O publisher **só enxerga o que foi confirmado** (READ COMMITTED). Não existe caminho para publicar
     antes do COMMIT da transação financeira: nem o use case nem o consumer falam com o broker.
   - Resultado por mensagem: o `SendMessageBatch` informa sucesso e falha de cada entrada, e um lote que
     falha inteiro (timeout, SQS fora do ar) não impede os outros. Mensagem sem confirmação explícita
     conta como falha. O motivo logado é só o código do erro, sem conteúdo do evento.
   - **Sem limite de tentativas:** desistir perderia um evento confirmado (invariante do desafio). O
     backoff de `OutboxMessage` (1s, 2s, 4s… teto 60s) fica no `next_attempt_at` do banco, então vale
     para qualquer instância.
   - Ordem do `claimDue`: `next_attempt_at, id` (a ordem do índice; o §9 dizia `occurred_at`). É só
     preferência: a fila é standard.
2. **Fila standard `wagering-events`, não FIFO.** O corpo é o envelope gravado na outbox, sem mudança;
   os atributos `event-id`, `event-type`, `aggregate-id` e `correlation-id` permitem filtrar e
   deduplicar sem abrir o corpo. A ordem por wallet sai do `walletVersion` do `WalletBalanceChanged`,
   que é contíguo. Uma FIFO por `aggregateId` não ordenaria eventos de agregados diferentes (transação
   e wallet) e limitaria o throughput por grupo.
3. **Limite do PENDING_REFERENCE: 10 tentativas, contadas por tentativa (não TTL).**
   - Cronograma: 1ª tentativa 1s depois da chegada; depois 2s, 4s, 8s, 16s, 32s e 60s × 4. A 10ª
     tentativa (a que rejeita) acontece **303 s (~5 min) depois da chegada**.
   - Por que 5 min: a referência fora de ordem vem de entregas concorrentes ou de retries do provedor.
     O consumer SQS tenta por ~1 min antes da DLQ (seção 18.5) e o HTTP devolve 503 com
     `Retry-After: 1`; 5 min cobrem com folga os dois caminhos e ainda dão ao provedor uma resposta
     definitiva rápida (`REFERENCE_NOT_FOUND` → `fix_payload`). Mais que isso deixaria uma reversão
     legítima sem resposta por muito tempo.
   - Por que por tentativa e não por TTL: se o worker ficar fora do ar, um TTL rejeitaria de uma vez
     tudo o que venceu durante a queda, sem nenhuma tentativa real. Contando tentativas, cada reversão
     tem as suas 10 chances de encontrar a referência.
   - Configurável por `PENDING_REF_MAX_ATTEMPTS`; o backoff fica no domínio (`WagerTransaction`).
4. **Worker: candidatos sem lock, lock wallet → transação, nova checagem** (`RetryPendingReferences`).
   - Travar a transação na busca (`SKIP LOCKED` em `wager_transactions`) inverteria a ordem de lock e
     abriria espaço para deadlock com o use case. Por isso a busca é sem lock, e dois workers podem ler
     o mesmo candidato.
   - Depois dos dois locks, o worker confere `isReferenceRetryDue(agora)`. Quem chega depois encontra a
     tentativa já agendada para o futuro (ou a transação terminal) e pula (`SKIPPED`). Uma tentativa
     nunca é contada duas vezes, e o trigger de guarda impede `reference_attempts` de diminuir.
   - O reprocessamento é o mesmo `applyWager` do use case (`isNew: false`): todas as regras de
     referência valem (por exemplo, `AMOUNT_MISMATCH` se a referência chegar com outro valor), com saldo,
     ledger, transação e outbox na mesma transação SQL.
   - Um erro num candidato (lock timeout numa wallet disputada) é registrado e não impede os outros;
     nada foi gravado, e ele volta no próximo ciclo.
5. **`correlation_id` em `wager_transactions`** (migration `Migration20261106180000`). Os eventos do
   worker levam a correlação da requisição ou mensagem original. Metadado: não entra no
   `payload_hash`, é imutável (`tg_wager_tx_guard_correlation`) e tem formato checado
   (`ck_wager_tx_correlation_id`: até 128 caracteres ASCII visíveis, como o `X-Correlation-Id` e o
   `messageId`). Anulável só para as linhas anteriores à migration.
6. **Guarda da outbox no schema** (mesma migration): `tg_outbox_guard_update` (envelope imutável,
   mensagem publicada não muda mais, `attempts` não diminui) e `tg_outbox_no_pending_delete` (apagar
   mensagem pendente perderia um evento confirmado; apagar publicada continua possível, para retenção).
7. **`idle_in_transaction_session_timeout`** em toda UnitOfWork (`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`,
   padrão 30s, validado acima de `OUTBOX_PUBLISH_TIMEOUT_MS`): um publisher (ou qualquer instância)
   congelado no meio de uma transação perde a sessão e solta os locks (seção 12).
8. **Workers no Nest:** `PollingWorker` (`src/interfaces/workers`) roda um ciclo atrás do outro quando o
   lote vem cheio e espera o intervalo quando não; um ciclo que falha (banco fora) pausa com backoff
   (500 ms até 30 s) sem matar o loop. No SIGTERM (`beforeApplicationShutdown`) não começa outro ciclo
   e espera o atual terminar. Nenhum estado de negócio fica em memória: o banco diz o que está vencido.
   Configuração nova: `OUTBOX_BATCH_SIZE` (50), `OUTBOX_POLL_INTERVAL_MS` (500),
   `OUTBOX_PUBLISH_TIMEOUT_MS` (10000), `PENDING_REF_BATCH_SIZE` (100), `PENDING_REF_POLL_INTERVAL_MS`
   (1000), `PENDING_REF_MAX_ATTEMPTS` (10), `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (30000).
9. **Testes** (Postgres e LocalStack reais; todos terminam com `expectConsistentWallets`):
   - Banco **descartável e migrado por arquivo** (`createIsolatedDatabase`): os workers leem a tabela
     inteira, e o `wagering_test` acumula milhares de eventos e pendências de outras suítes. Fila de
     eventos própria por arquivo (`TestEventsQueue`). O teste de health (`ROLE=all`, que agora liga os
     workers) também passou a usar banco e filas próprios.
   - O `SqsProxy` ganhou `holdResponse` (o SQS recebeu, o cliente ainda não sabe) e `fail` (o SQS
     recusa).
   - `expectConsistentWallets` reconhece a reversão resolvida pelo worker (`processed_at > created_at`:
     o use case grava os dois com o mesmo instante) e passa a exigir também o
     `WagerTransactionPendingReference` da chegada.
   - `test/integration/outbox/publisher.test.ts`: envelope intacto e `published_at`; **nunca antes do
     COMMIT** (um trigger de teste prende a BET no COMMIT com tudo escrito, e o publisher não a vê);
     dois publishers com SKIP LOCKED (o lote travado por A é pulado por B, sem espera nem duplicata);
     SQS recusando, com backoff 1s, 2s, 4s observado num relógio controlado.
   - `test/integration/outbox/outbox-constraints.test.ts`: cada guarda nova barra o dado inválido.
   - `test/integration/pending-reference/worker.test.ts` (relógio controlado, sem sleeps): REFUND antes
     da BET (202 → resolvido com a correlação original, replay 200); ROLLBACK antes do WIN; referência
     que não bate (`AMOUNT_MISMATCH`); **limite de tentativas** com o cronograma exato até
     `REFERENCE_NOT_FOUND` (replay 422); dois workers e a API na mesma wallet (tentativa contada uma
     vez, sem deadlock); lock timeout sem gravar nada.
   - `test/concurrency/outbox-publishers.test.ts` (processos `ROLE=outbox`): dois publishers com 200
     eventos (cada evento enviado por uma instância só); a API confirma e morre, o publisher A morre
     antes de a chamada chegar ao SQS e o B publica; A publica e morre antes do COMMIT, B publica de
     novo: 2 cópias idênticas, e um consumidor com inbox por `eventId` aplica um efeito por evento.
   - `test/concurrency/pending-reference-workers.test.ts` (2 processos `ROLE=pending-ref`): 20
     reversões resolvidas e 10 sem referência rejeitadas com exatamente 3 tentativas (limite reduzido
     no teste), com os eventos exatos.
   - Unitários: `PublishOutbox` (falha parcial, entrada sem confirmação, broker fora) e `PollingWorker`.
