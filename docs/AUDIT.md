# AUDIT.md: auditoria contra o desafio

Conferência, item por item, das **falhas eliminatórias**, das **restrições invioláveis**, dos **testes
obrigatórios** e da **tabela de avaliação** do [enunciado](CHALLENGE.md) (seções 5, 13 e 14). Cada item
aponta onde a garantia está no código, no schema e em qual teste ela é provada.

- Base: commit `17fc8f3` (fim da fase 8) + documentação da fase 9.
- Legenda: ✅ atendido · ⚠️ atendido com limitação documentada · ➖ opcional não feito.
- Os testes de integração e de concorrência rodam contra **Postgres e LocalStack reais** (docker compose).
  Caminhos de teste são relativos a `test/`.
- Limitações completas e trade-offs: [ARCHITECTURE.md §12](../ARCHITECTURE.md#12-limitações-e-trade-offs).

## 1. Falhas eliminatórias (seção 14)

| # | Falha eliminatória | | Por que não acontece | Evidência (código / schema) | Testes |
|---|---|---|---|---|---|
| 1 | `number` para dinheiro | ✅ | Dinheiro é `decimal.js` no domínio, string `"25.00"` nos contratos e `numeric(20,2)` no banco. O tipo do ORM recusa `number` nos dois sentidos. Número JSON no `amount` é 400 (HTTP) ou DLQ (fila). | `src/domain/money/money.ts`, `src/infrastructure/database/types/decimal-amount.type.ts`, `src/interfaces/contracts/wager-contract.ts` (`amount: z.string()`), migrations com `numeric(20,2)` | `unit/domain/money.test.ts` (entradas inválidas, sem erro de ponto flutuante, estouro de `numeric(20,2)`), `unit/infrastructure/decimal-amount-type.test.ts` ("recusa number nos dois sentidos"), `integration/repositories.test.ts` ("limite de numeric(20,2) volta exato"), `integration/http/wagering-rules.test.ts` e `wallets.test.ts` ("amount numérico" → 400), `unit/interfaces/sqs/wager-message.test.ts` |
| 2 | Saldo negativo causado por race | ✅ | Lock pessimista por wallet (`FOR UPDATE`) e decisão com o saldo travado em READ COMMITTED. Rede de segurança: `CHECK (balance >= 0)` em wallet, ledger e snapshot. | `src/infrastructure/database/repositories.ts` (`LockMode.PESSIMISTIC_WRITE`), `src/application/wagering/process-wager-transaction.ts`; `ck_wallets_balance_non_negative`, `ck_ledger_balances_non_negative`, `ck_wager_tx_snapshot_non_negative` | `concurrency/mandatory-scenario.test.ts` (100.00 e duas BET de 80.00 por 3 instâncias, com barreira no lock), `concurrency/hot-wallet.test.ts` (45 operações presas no lock; ROLLBACK × BET), `integration/schema-constraints.test.ts` ("saldo nunca negativo"), `consistency.ts` confere que nenhum saldo intermediário do ledger é negativo |
| 3 | Débito ou crédito duplicado | ✅ | Idempotência persistente checada dentro do lock da wallet, índices únicos e um lançamento por transação. A reversão só pode acontecer uma vez por referência. | `ux_wager_tx_idempotency_key`, `ux_wager_tx_provider_external`, `ux_ledger_transaction`, `ux_ledger_wallet_version`, `ux_wager_tx_reversal_once`, PK `pk_inbox_messages` | `concurrency/same-bet-50x.test.ts` (50 cópias no lock ao mesmo tempo → 1 débito), `concurrency/hot-wallet.test.ts` (REFUND + ROLLBACK + REFUND duplicado → 1 crédito), `integration/sqs/consumer.test.ts` (redelivery, duas instâncias com a mesma mensagem), `concurrency/consumer-crash.test.ts`, `concurrency/restart.test.ts` (retry depois de queda), `integration/schema-constraints.test.ts` (dois lançamentos para a mesma transação, reversão dupla) |
| 4 | Idempotência apenas em memória | ✅ | Não existe estado de idempotência em memória: chave e hash ficam em `wager_transactions` e a entrega SQS fica em `inbox_messages`. Os `Map`/`Set` do código são listas fixas de códigos ou estruturas locais de um lote, não dedup. | `src/application/wagering/process-wager-transaction.ts`, `src/domain/wager/payload-hash.ts`; índices únicos acima | `concurrency/restart.test.ts` ("reinício completo… replays idênticos": processos novos, sem memória), `integration/http/idempotency.test.ts`, `integration/sqs/inbox.test.ts` |
| 5 | Solução correta somente com uma instância | ✅ | Lock, unicidade, inbox, outbox (`SKIP LOCKED`) e agendamento de retries vivem no Postgres. Nenhuma instância guarda estado de negócio. | `src/application/messaging/publish-outbox.ts`, `src/application/wagering/retry-pending-references.ts` | Toda a pasta `concurrency/` usa **processos reais**: `bun src/main.ts` × 3 (`support/cluster.ts`), 3 consumers (`consumer-crash`), 2 publishers (`outbox-publishers`), 2 workers (`pending-reference-workers`) |
| 6 | Publicação de evento antes do commit | ✅ | O use case só grava na outbox, na mesma transação SQL. Só o publisher fala com o broker, e ele só enxerga linhas confirmadas. Não existe outro caminho até o SQS. | `src/application/messaging/publish-outbox.ts`, `src/infrastructure/messaging/sqs-event-publisher.ts`; `tg_outbox_guard_update`, `tg_outbox_no_pending_delete` | `integration/outbox/publisher.test.ts` ("nunca publica antes do COMMIT": a transação fica presa no COMMIT com tudo escrito), `concurrency/outbox-publishers.test.ts` ("commit confirmado e processo morto antes de publicar") |
| 7 | Ausência de ledger auditável | ✅ | `wallet_ledger_entries` é append-only, com `balance_before`/`balance_after`, `wallet_version` contígua e aritmética checada. A consistência saldo ↔ ledger ↔ transação é conferida no COMMIT. REJECTED também fica gravado. Reconciliação por endpoint. | `tg_ledger_append_only`, `tg_ledger_no_truncate`, `ck_ledger_arithmetic`, `tg_ledger_consistency`, `tg_wallet_matches_ledger`, `tg_wager_tx_has_entry`, `tg_wager_tx_no_delete`; `src/application/wallets/reconcile-wallet.ts` | `integration/schema-constraints.test.ts` ("ledger imutável", "consistência saldo ↔ ledger ↔ transação"), `integration/http/ledger-and-reconciliation.test.ts` (cursor estável, divergência sinalizada e não corrigida) |
| 8 | Testes que substituem completamente PostgreSQL e SQS por mocks | ✅ | Integração e concorrência sobem Postgres 16 e LocalStack 3.8 reais. O único dublê é a fila em memória do teste **unitário** do loop do consumer. | `test/setup.ts`, `support/database.ts`, `support/sqs.ts`, `support/sqs-proxy.ts` (proxy HTTP real na frente do LocalStack, sem gancho no código de produção) | 28 arquivos em `integration/` (20) e `concurrency/` (8); o dublê fica só em `unit/interfaces/sqs/wager-message-consumer.test.ts` |

## 2. Restrições invioláveis (seção 5)

| # | Restrição | | Evidência |
|---|---|---|---|
| 1 | Sem `number`/`float`/`double` para dinheiro | ✅ | Eliminatória 1 |
| 2 | Sem cache em memória como garantia de idempotência | ✅ | Eliminatória 4 |
| 3 | Não confiar só no SQS FIFO | ✅ | A inbox `(consumer_name, message_id)` e a idempotency key valem mesmo fora da janela de dedup do FIFO: `integration/sqs/consumer.test.ts` ("redelivery… fora da dedup do FIFO"). Uma ordem errada vira PENDING_REFERENCE (`integration/pending-reference/worker.test.ts`). ARCHITECTURE §18.7 |
| 4 | Não publicar antes do commit | ✅ | Eliminatória 6 |
| 5 | Não sobrescrever nem excluir o ledger | ✅ | `tg_ledger_append_only` / `tg_ledger_no_truncate`; teste "UPDATE, DELETE e TRUNCATE falham" |
| 6 | Sem lock global | ✅ | Lock de uma linha de `wallets`. `concurrency/distinct-wallets.test.ts`: com a wallet A travada, 27 operações em outras 9 wallets terminam |
| 7 | Sem `read → calculate → update` sem controle | ✅ | `WalletRepository.save` exige a wallet travada (`RepositoryMisuseError`), e `tg_wallets_guard_update` barra o UPDATE feito sobre uma leitura antiga. Testes: `integration/unit-of-work.test.ts` ("save sem lock é recusado"), `schema-constraints.test.ts` ("lost update: UPDATE calculado sobre leitura antiga é barrado") |
| 8 | Correta com múltiplas instâncias | ✅ | Eliminatória 5 |
| 9 | Unicidade, imutabilidade e não-negatividade **no schema** | ✅ | Tabela de garantias em ARCHITECTURE §6. Cada uma é barrada por SQL puro em `integration/schema-constraints.test.ts` e `integration/outbox/outbox-constraints.test.ts`. `integration/migrations.test.ts` prova o up/down |

## 3. Testes obrigatórios (seção 13)

### Unidade

| Exigido | | Onde |
|---|---|---|
| `Money`: escala, arredondamento, entradas inválidas | ✅ | `unit/domain/money.test.ts`. Não existe modo de arredondamento: mais de 2 casas é rejeitado, nunca arredondado (ARCHITECTURE §14.3), e o estouro é erro |
| Invariantes da `Wallet` | ✅ | `unit/domain/wallet.test.ts` (saldo insuficiente não altera nada, version só sobe quando o saldo muda, saldo == ledger), `unit/domain/wallet-ledger-entry.test.ts` |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK | ✅ | `unit/domain/wager-transaction.test.ts`, `unit/domain/wager-policy.test.ts`, `unit/domain/reference-rules.test.ts` |
| Conflito de moeda | ✅ | `money.test.ts` ("Money conflito de moeda"), `wallet.test.ts` ("conflito de moeda") |
| Idempotency key com payload divergente | ✅ | `wager-transaction.test.ts` ("mesma idempotency key com valor diferente → conflito, não replay"), `unit/domain/payload-hash.test.ts` |

### Integração (Postgres e LocalStack reais)

| Exigido | | Onde |
|---|---|---|
| Migrations e constraints | ✅ | `integration/migrations.test.ts` (up, down de cada migration, down até o início e up de novo), `schema-constraints.test.ts`, `outbox/outbox-constraints.test.ts` |
| Atomicidade entre wallet, ledger, inbox e outbox | ✅ | `integration/sqs/inbox.test.ts` ("falha no COMMIT com transação, saldo, ledger, outbox e inbox escritos → nada fica"), `http/atomicity-and-failures.test.ts` (falha no flush e no COMMIT), `unit-of-work.test.ts` |
| Inbox e redelivery | ✅ | `sqs/inbox.test.ts`, `sqs/consumer.test.ts` |
| Publishers concorrentes sobre a mesma outbox | ✅ | `outbox/publisher.test.ts` ("dois publishers… SKIP LOCKED"), `concurrency/outbox-publishers.test.ts` |
| Retry e DLQ | ✅ | `sqs/retry-and-dlq.test.ts` (backoff observado pelo proxy, redrive após 5 recebimentos, permanentes direto para a DLQ com o motivo), `outbox/publisher.test.ts` ("SQS recusando… backoff") |
| Recuperação após reinicialização | ✅ | `concurrency/restart.test.ts`, `concurrency/outbox-publishers.test.ts`, `concurrency/consumer-crash.test.ts`, `sqs/shutdown.test.ts` |

### Concorrência (paralelismo real)

A simultaneidade é **comprovada**, não suposta: uma conexão do teste trava a wallet e só a solta quando o
`pg_stat_activity` mostra todas as requisições esperando, vindas das 3 instâncias (ARCHITECTURE §17.2).

| # | Exigido | | Onde |
|---|---|---|---|
| 1 | Mesma aposta 50x em paralelo → um débito | ✅ | `concurrency/same-bet-50x.test.ts` (com barreira; e em rajada em 10 wallets) |
| 2 | Cenário obrigatório (100.00, duas BET de 80.00) | ✅ | `concurrency/mandatory-scenario.test.ts` (instâncias diferentes, retries que não duplicam, rajada em 20 wallets) e `integration/unit-of-work.test.ts` |
| 3 | Wallets distintas em paralelo | ✅ | `concurrency/distinct-wallets.test.ts` |
| 4 | ≥ 3 processos/instâncias | ✅ | `support/cluster.ts`: 3 processos `ROLE=api` por arquivo; 3 consumers em `consumer-crash.test.ts` |
| 5 | Worker morto depois do commit e antes do ack | ✅ | `concurrency/consumer-crash.test.ts` (o proxy segura o `DeleteMessage` e o processo leva SIGKILL) |
| 6 | Dois publishers sobre a mesma outbox | ✅ | `concurrency/outbox-publishers.test.ts` (200 eventos, cada um enviado por uma instância só) |
| 7 | ROLLBACK/REFUND antes da referência | ✅ | `concurrency/pending-reference-workers.test.ts` (2 workers em processos), `integration/pending-reference/worker.test.ts` (inclui o limite de tentativas → `REFERENCE_NOT_FOUND`) |
| 8 | Reinício com consistência final | ✅ | `concurrency/restart.test.ts` (instância morta com requisições no lock; reinício das 3; queda das 3 no meio de 120 operações) |

### Invariante final: `wallet.balance == saldo reconstruído pelo ledger`

✅ Todos os arquivos de integração e concorrência que criam wallets terminam com essa checagem:
`expectBalanceMatchesLedger` (`support/database.ts`) ou `expectConsistentWallets` (`support/consistency.ts`,
que também confere a sequência do ledger, um lançamento por transação e os eventos da outbox). Nos
arquivos de `concurrency/` ela roda em todo `afterEach`, via `useConcurrencySuite`. Os três arquivos que
não criam wallet não fazem a checagem porque não teriam o que conferir: `database.test.ts` (SELECT 1),
`migrations.test.ts` (banco descartável) e `health.test.ts`.

## 4. Tabela de avaliação (seção 14)

| Área (pontos) | | Evidências principais | Limitações conhecidas |
|---|---|---|---|
| Correção financeira (20) | ✅ | `Money` com escala fixa e multi-moeda; saldo com `CHECK >= 0`; ledger append-only com encadeamento e versão; reversões com regras completas (`ReferenceRules`, códigos distintos `INSUFFICIENT_FUNDS` × `REVERSAL_INSUFFICIENT_FUNDS`, `ALREADY_REVERSED`); reconciliação que sinaliza, loga e conta. ARCHITECTURE §3, §6, §7, §14 | Ledger de partida simples (o de partidas dobradas é opcional). Reversão parcial fora de escopo (desafio). Uma reversão por referência, de qualquer tipo: interpretação mais restritiva que a regra 4 (§14.1) |
| Concorrência (20) | ✅ | Lock pessimista por wallet, ordem wallet → transação, `lock_timeout`, prova de correção em ARCHITECTURE §4, suíte `concurrency/` com processos reais e barreira no Postgres | Uma wallet muito disputada processa uma transação por vez (custo aceito, §4). Instância **congelada** no meio de um comando segura o lock até o keepalive TCP (§12) |
| Idempotência (15) | ✅ | Header obrigatório; hash SHA-256 do JSON canônico (§5, §14.4); replay com snapshot do saldo; 409 para payload divergente e para `externalTransactionId` reutilizado; corridas determinísticas em `http/idempotency.test.ts`; inbox persistente | `FAILED` não é produzido: quem desiste é a DLQ, e a key fica livre para reprocessar (§18.9) |
| Mensageria e falhas (15) | ✅ | Inbox na mesma transação, ack depois do COMMIT, classificação negócio/transitório/permanente (§18.4), backoff pela contagem do SQS, DLQ com motivo, shutdown gracioso, outbox com `SKIP LOCKED` e at-least-once deduplicável por `eventId` | O teste com SIGTERM real é pulado no Windows; o `app.close()` cobre o mesmo caminho, e o README mostra como rodá-lo num container. Sem heartbeat de visibilidade (§12) |
| Modelagem e arquitetura (10) | ✅ | Hexagonal: `domain` importa só `decimal.js` e `node:crypto`, e `application` só o `domain`. Construtor `private` + factories, `rehydrate` sem revalidação; eventos como subclasses com `eventType`/`version` no tipo; HTTP e SQS chamam o mesmo `ProcessWagerTransaction` | Assinaturas ajustadas em relação ao esqueleto do desafio (snapshot de saldo nas transições, `Wallet.open` devolve o lançamento), §14.6 |
| Testes (10) | ✅ | Unitários do domínio; integração real por regra e por constraint; concorrência com processos reais, falhas injetadas no Postgres (flush e COMMIT), proxy SQS para segurar ou recusar chamadas, relógio controlado nos workers, sem sleeps fixos | `bun test` completo leva alguns minutos (sobe processos e espera backoffs reais do SQS). Os testes de divergência precisam desligar os triggers na sessão (§12) |
| Observabilidade (5) | ✅ | Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; nenhum valor ou saldo nos logs (testado); `/metrics` com todas as métricas exigidas; `/health/live` e `/health/ready` por papel. ARCHITECTURE §10, `integration/observability/observability.test.ts`, `integration/health.test.ts` | Métricas por processo (zeram no reinício). `/metrics` sem autenticação. Sem OpenTelemetry nem dashboard (opcionais) |
| Documentação (5) | ✅ | `README.md` (requisitos, setup, comandos, cada suíte); `ARCHITECTURE.md` (decisões, trade-offs, limitações, autenticação); este arquivo | |

## 5. Itens opcionais e fora de escopo

| Item | | Situação |
|---|---|---|
| Autenticação com IdP | ➖ | Não implementada, como o desafio permite. O ponto de extensão `ProviderAuthGuard` (no-op) fica nos controllers de negócio, e o desenho completo está em ARCHITECTURE §11 |
| `bun run test:load` | ➖ | Não feito. A suíte de concorrência mede correção, não throughput. Não há números de p50/p95/p99 |
| Ledger de partidas dobradas | ➖ | Não feito (diferencial opcional) |
| Réplicas no docker compose | ➖ | O compose roda uma instância. A correção com N instâncias é provada pelos testes com processos reais (§17.1), não por um perfil de demonstração |
| OpenTelemetry / dashboard | ➖ | Não feito (opcional) |

## 6. Lacunas

Nenhuma lacuna em relação aos itens obrigatórios. As limitações acima são escolhas ou custos conhecidos e
estão descritas em [ARCHITECTURE.md §12](../ARCHITECTURE.md#12-limitações-e-trade-offs).
