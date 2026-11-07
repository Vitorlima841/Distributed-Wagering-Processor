# PLAN.md — Plano de execução

Enunciado: `docs/CHALLENGE.md` · Regras: `CLAUDE.md` · Decisões: `ARCHITECTURE.md`

## Como usar este plano

- **Uma fase = uma sessão nova** (nova conversa ou `/clear`). Cole o prompt da fase, que está no fim deste arquivo.
- Ao terminar uma fase: marque o checklist, anote decisões no `ARCHITECTURE.md` e **faça commit**.
- Se a sessão ficar longa demais no meio de uma fase, peça ao Claude para registrar o progresso aqui,
  abra uma sessão nova e diga "continue a fase X a partir do `docs/PLAN.md`".
- Sempre peça **o plano primeiro** (Plan mode) nas fases marcadas com ⚠️.

## Fases

| # | Fase | Modelo | Esforço |
|---|---|---|---|
| 0 | Planejamento e documentação base | Opus | high |
| 1 | Scaffolding e infraestrutura local | Sonnet | medium |
| 2 | Domínio + testes unitários | Sonnet (Opus se travar) | high |
| 3 ⚠️ | Schema, constraints, migrations, persistência | Opus | xhigh |
| 4 ⚠️ | Use cases + API HTTP + idempotência | Opus | xhigh |
| 5 ⚠️ | Testes de concorrência e multi-instância | Opus | xhigh |
| 6 ⚠️ | Consumer SQS + inbox + retry/DLQ + shutdown | Opus | high |
| 7 ⚠️ | Outbox publisher + worker PENDING_REFERENCE | Opus | high |
| 8 | Observabilidade | Sonnet | medium |
| 9 | Documentação final + revisão | Sonnet (+ `/code-review`) | medium |

### Fase 0 — Planejamento ✅
- [x] `docs/CHALLENGE.md` (cópia do enunciado)
- [x] `CLAUDE.md` com stack, restrições, falhas eliminatórias e regras de trabalho
- [x] `ARCHITECTURE.md` (rascunho das decisões)
- [x] `docs/PLAN.md` com fases, checklist e prompts
- [x] Revisão humana: ler os três arquivos e ajustar o que discordar
- [x] Commit

### Fase 1 — Scaffolding e infraestrutura local ✅
- [x] Projeto NestJS rodando em Bun, `tsconfig` estrito (`strict`, `noUncheckedIndexedAccess`, decorators)
- [x] Estrutura de pastas hexagonal (`domain`, `application`, `infrastructure`, `interfaces`)
- [x] `docker-compose.yml`: Postgres + LocalStack (cria as filas `wager-transactions.fifo`,
      `wager-transactions-dlq.fifo` com redrive e `wagering-events`) + serviço `app` com `ROLE`
- [x] MikroORM configurado (Postgres, migrations, `EntitySchema`)
- [x] Config por env validada na inicialização
- [x] Lint/format (ESLint ou Biome) + scripts no `package.json` (`test`, `test:unit`, `test:integration`,
      `test:concurrency`, `typecheck`, `migration:up/down`)
- [x] Bootstrap por papel (`ROLE=api|consumer|outbox|pending-ref|all`)
- [x] `GET /health/live` respondendo
- [x] Um teste trivial de integração conectando no Postgres real
- [x] README com setup inicial

### Fase 2 — Domínio + testes unitários ✅
- [x] `Money` (decimal.js, escala 2, validação de entrada, conflito de moeda, imutável)
- [x] `Wallet` (open, rehydrate, debit/credit que retornam o `WalletLedgerEntry`, version)
- [x] `WagerTransaction` (create/rehydrate, transições, `requiresReference`, `affectsBalance`,
      `ledgerDirectionFor`, `matchesPayload`)
- [x] `WalletLedgerEntry` (imutável, `isBalanced` checado na factory)
- [x] `InboxMessage`, `OutboxMessage` (com `scheduleRetry` e backoff)
- [x] `IntegrationEvent` abstrata + 4 subclasses
- [x] `FailureCode` e erros de domínio
- [x] Serviço de domínio de regras de referência (REFUND/ROLLBACK)
- [x] Hash canônico do payload (função pura)
- [x] Testes unitários de tudo acima (incluindo idempotency key com payload divergente)

### Fase 3 — Schema e persistência ⚠️ ✅
- [x] Migrations reversíveis com todas as tabelas, constraints, índices e o trigger do ledger
- [x] Tipo customizado `Money` ↔ `numeric(20,2)` (sem passar por `number`): `DecimalAmountType` + mapper
- [x] `EntitySchema` + mappers (domínio ↔ persistência usando `rehydrate`)
- [x] Repositórios implementando os ports + `UnitOfWork` sobre `em.transactional()`
- [x] `findByIdForUpdate` com `LockMode.PESSIMISTIC_WRITE`
- [x] Extra: guardas de UPDATE, FKs compostas e consistência saldo ↔ ledger ↔ transação no COMMIT
      (`walletVersion` no lançamento), ver ARCHITECTURE §15
- [x] Testes de integração: migrations up/down; cada constraint barra o dado inválido
      (saldo negativo, wallet duplicada, ledger UPDATE/DELETE, aritmética do ledger, reversão dupla,
      idempotency key duplicada)

### Fase 4 — Use cases + API HTTP ⚠️ ✅
- [x] `CreateWallet` (com OPENING + ledger CREDIT na mesma transação; 409 se duplicada)
- [x] `ProcessWagerTransaction`: BET, WIN, LOSS, REFUND, ROLLBACK, referência ausente → PENDING_REFERENCE
- [x] Idempotência: replay com snapshot e conflito por hash
- [x] Outbox gravada na mesma transação (eventos certos para cada caso)
- [x] Endpoints da seção 9 (incluindo ledger com cursor opaco e reconciliação)
- [x] Mapeamento HTTP consistente (filtro global de exceções)
- [x] `AuthGuard` no-op como ponto de extensão
- [x] Testes de integração por regra de negócio + atomicidade (falha no meio → nada gravado)
- [x] Extra: corridas determinísticas de idempotência (espera no lock, colisão no índice único) e
      503 por `lock_timeout`, ver ARCHITECTURE §16

### Fase 5 — Concorrência ⚠️ ✅
- [x] Mesma aposta 50x em paralelo → um único débito
- [x] Cenário obrigatório: 100.00, duas BET de 80.00 → uma PROCESSED, uma REJECTED, saldo 20.00, 1 débito
- [x] Wallets distintas em paralelo (sem serialização entre elas)
- [x] ≥ 3 processos/instâncias simultâneos (processos reais, por exemplo `Bun.spawn` ou réplicas do compose)
- [x] Reinício do serviço com comprovação da consistência final
- [x] Todos terminam com `wallet.balance == saldo reconstruído pelo ledger`
- [x] Extra: hot wallet com 45 operações misturadas, reversões concorrentes da mesma BET, queda de todas
      as instâncias no meio de uma carga; checagem final também da sequência do ledger e da outbox
      (ver ARCHITECTURE §17)

### Fase 6 — Consumer SQS ⚠️ ✅
- [x] Consumer com long polling, chamando o mesmo use case
- [x] Inbox `(consumerName, messageId)` na mesma transação
- [x] Ack só após commit
- [x] Classificação de erros: negócio (ack), transitório (visibilidade + backoff), permanente (DLQ)
- [x] Redrive para DLQ após `maxReceiveCount`
- [x] Graceful shutdown no SIGTERM
- [x] Testes: redelivery, worker morto depois do commit e antes do ack, retry, DLQ
- [x] Extra: atomicidade da inbox com falha no COMMIT, duas instâncias com a mesma mensagem, 3 consumers
      em processos com duplicatas, shutdown sem cancelar o long poll (achado no LocalStack), filas
      próprias por arquivo de teste e proxy do SQS para observar/segurar chamadas (ver ARCHITECTURE §18)

### Fase 7 — Outbox + PENDING_REFERENCE ⚠️ ✅
- [x] Publisher com `FOR UPDATE SKIP LOCKED`, backoff e `markPublished`
- [x] Worker PENDING_REFERENCE (ordem de lock wallet → transação, backoff, limite → REJECTED)
- [x] Testes: dois publishers na mesma outbox; commit + morte antes de publicar → outra instância publica;
      REFUND/ROLLBACK antes da referência; esgotar tentativas
- [x] Extra: publicação duplicada deduplicada por um consumidor com inbox; "nunca antes do COMMIT"
      com a transação presa no COMMIT; `correlation_id` na transação; guarda da outbox no schema;
      `idle_in_transaction_session_timeout`; dois workers em processos (ver ARCHITECTURE §19)

### Fase 8 — Observabilidade ✅
- [x] Logger JSON com contexto (`correlationId` propagado do HTTP/SQS até o evento)
- [x] Métricas exigidas em `/metrics`
- [x] `/health/ready` checando Postgres e SQS
- [x] Reconciliação logando e contando divergências
- [x] Checar que nenhum log vaza payload financeiro completo
- [x] Extra: contexto de log por `AsyncLocalStorage` (o filtro de erros e o publisher herdam a
      correlação), gauges de backlog lidos no scrape (outbox e DLQ, incluindo o redrive nativo),
      readiness por papel e `shutting_down` no SIGTERM (ver ARCHITECTURE §10)

### Fase 9 — Documentação final + revisão
- [x] `README.md`: requisitos, setup, comandos, como rodar cada suíte de testes
- [x] `ARCHITECTURE.md` final: decisões, trade-offs e limitações (§12), desenho de autenticação (§11)
- [ ] `/code-review` e correção dos achados
- [x] Conferir item a item as falhas eliminatórias e a tabela de avaliação (`docs/AUDIT.md`)
- [ ] (Opcional) `bun run test:load`: não feito, registrado em ARCHITECTURE §12 e no AUDIT
- [x] Clone limpo seguindo só o README: stack do zero (`--build`, volume novo), exemplos da API e
      da fila, e as três suítes rodando a partir do clone (ARCHITECTURE §20)

---

## Prompts por fase

Cole o prompt da fase numa **sessão nova**, com o modelo e o esforço da tabela acima.

### Prompt — Fase 1 (Sonnet · medium)

```
Contexto: estamos na fase 1 do @docs/PLAN.md. Leia @CLAUDE.md, @ARCHITECTURE.md (seções 1, 2 e 9) e @docs/CHALLENGE.md seções 4 e 10.
Objetivo: criar o esqueleto do projeto: NestJS em Bun com TypeScript estrito, pastas da arquitetura hexagonal, docker-compose (Postgres + LocalStack criando as filas wager-transactions.fifo, wager-transactions-dlq.fifo com redrive e wagering-events), MikroORM com migrations, config por env validada, bootstrap por ROLE, lint e scripts do package.json.
Restrições: nada de lógica de negócio ainda; nada de Prisma; domínio sem dependência de framework; tudo roda com `docker compose up` + `bun`.
Pronto quando: `docker compose up -d` sobe tudo; GET /health/live responde 200; um teste de integração conecta no Postgres real; `bun test` e `bunx tsc --noEmit` passam; README tem o setup; checklist da fase 1 marcado.
Antes de codar: me mostre o plano e as dúvidas (especialmente sobre compatibilidade de Bun com NestJS/MikroORM e decorators).
```

### Prompt — Fase 2 (Sonnet · high)

```
Contexto: estamos na fase 2 do @docs/PLAN.md. Leia @CLAUDE.md, @ARCHITECTURE.md (seções 3, 5 e 7) e @docs/CHALLENGE.md seções 6, 7 e 11.
Objetivo: implementar a camada de domínio em src/domain (Money, Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage, IntegrationEvent + 4 eventos, FailureCode, erros, regras de referência e hash canônico do payload), com testes unitários escritos ANTES de cada classe.
Restrições: TS puro, sem NestJS/MikroORM; construtor private + factories (rehydrate não revalida); Money com decimal.js, nunca number; estados terminais lançam InvalidTransactionStateError; eventos carregam MoneyProps, nunca Money.
Pronto quando: os testes unitários da seção 13 (Money, invariantes da Wallet, BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, idempotency key com payload divergente) passam; `bunx tsc --noEmit` sem erros; checklist da fase 2 marcado; interpretações novas registradas no ARCHITECTURE.md.
Antes de codar: me mostre o plano e as dúvidas.
```

### Prompt — Fase 3 (Opus · xhigh · Plan mode)

```
Contexto: estamos na fase 3 do @docs/PLAN.md. Leia @CLAUDE.md, @ARCHITECTURE.md (seções 3, 4 e 6) e @docs/CHALLENGE.md seções 5, 6 e 13. O domínio já existe em src/domain.
Objetivo: criar as migrations reversíveis (tabelas, CHECKs, índices únicos inclusive o parcial de reversão, trigger que bloqueia UPDATE/DELETE no ledger), o tipo customizado Money ↔ numeric(20,2), EntitySchemas + mappers, repositórios que implementam os ports e o UnitOfWork sobre em.transactional(), incluindo findByIdForUpdate com LockMode.PESSIMISTIC_WRITE.
Restrições: garantias de unicidade, imutabilidade e não-negatividade NO SCHEMA (restrição 9); dinheiro nunca passa por number; domínio continua sem importar MikroORM; reidratação sempre via rehydrate.
Pronto quando: testes de integração contra o Postgres real provam migrations up/down e que cada constraint barra o dado inválido (saldo negativo, wallet duplicada, UPDATE/DELETE no ledger, aritmética do ledger errada, reversão dupla, idempotency key duplicada); `bun test` e `bunx tsc --noEmit` passam; checklist marcado.
Antes de codar: me mostre o plano, o SQL das migrations e as dúvidas.
```

### Prompt — Fase 4 (Opus · xhigh · Plan mode)

```
Contexto: estamos na fase 4 do @docs/PLAN.md. Leia @CLAUDE.md, @ARCHITECTURE.md (seções 4, 5, 7 e 8) e @docs/CHALLENGE.md seções 7 e 9. Domínio e persistência já existem.
Objetivo: implementar os use cases CreateWallet (com OPENING) e ProcessWagerTransaction (BET, WIN, LOSS, REFUND, ROLLBACK e PENDING_REFERENCE), as consultas, a reconciliação e todos os endpoints HTTP da seção 9, com idempotência (replay com snapshot, conflito por hash) e outbox na mesma transação.
Restrições: lock pessimista na wallet (FOR UPDATE) e ordem de lock wallet → transação; tudo na mesma transação (tx, saldo, ledger, outbox); o use case não conhece HTTP (o consumer SQS vai reutilizá-lo); mapeamento HTTP consistente via filtro global; AuthGuard no-op como ponto de extensão.
Pronto quando: testes de integração contra Postgres real cobrem cada regra de negócio, replay, conflito de idempotência e atomicidade (falha no meio → nada gravado), e terminam com wallet.balance == saldo do ledger; `bun test` e `bunx tsc --noEmit` passam; checklist marcado.
Antes de codar: me mostre o plano (fluxo passo a passo dentro da transação) e as dúvidas.
```

### Prompt — Fase 5 (Opus · xhigh · Plan mode)

```
Contexto: estamos na fase 5 do @docs/PLAN.md. Leia @CLAUDE.md, @ARCHITECTURE.md (seção 4) e @docs/CHALLENGE.md seções 8 e 13. Use cases e API já existem.
Objetivo: escrever a suíte de concorrência em test/concurrency: mesma aposta 50x em paralelo, cenário obrigatório (100.00 com duas BET de 80.00), wallets distintas em paralelo, ≥ 3 instâncias reais simultâneas e reinício com prova de consistência final. Corrigir no código o que os testes revelarem.
Restrições: paralelismo real (requisições/processos simultâneos, não mocks sequenciais); Postgres real; testes determinísticos (sem sleeps frágeis); cada teste termina verificando wallet.balance == saldo reconstruído pelo ledger.
Pronto quando: `bun run test:concurrency` passa 10 vezes seguidas; `bun test` e `bunx tsc --noEmit` passam; checklist marcado; ARCHITECTURE.md explica por que a estratégia de lock é correta.
Antes de codar: me mostre o plano (como vai subir as 3 instâncias e garantir simultaneidade) e as dúvidas.
```

### Prompt — Fase 6 (Opus · high · Plan mode)

```
Contexto: estamos na fase 6 do @docs/PLAN.md. Leia @CLAUDE.md, @ARCHITECTURE.md (seção 9) e @docs/CHALLENGE.md seção 10. O use case ProcessWagerTransaction já existe.
Objetivo: implementar o consumer SQS de wager-transactions.fifo reutilizando o mesmo use case, com inbox persistente (consumerName, messageId), ack só após commit, classificação de erros (negócio → ack; transitório → visibilidade com backoff; permanente → DLQ), redrive após maxReceiveCount e graceful shutdown no SIGTERM.
Restrições: inbox na mesma transação SQL do resto; nada de dedup em memória; FIFO é otimização, não garantia; LocalStack real nos testes.
Pronto quando: testes de integração provam redelivery sem efeito duplicado, worker morto depois do commit e antes do ack, retry com backoff, mensagem indo para a DLQ e shutdown sem perda; invariante do ledger verificada; `bun test` e `bunx tsc --noEmit` passam; checklist marcado.
Antes de codar: me mostre o plano e as dúvidas.
```

### Prompt — Fase 7 (Opus · high · Plan mode)

```
Contexto: estamos na fase 7 do @docs/PLAN.md. Leia @CLAUDE.md, @ARCHITECTURE.md (seção 9) e @docs/CHALLENGE.md seções 7.1 e 11.
Objetivo: implementar o outbox publisher (FOR UPDATE SKIP LOCKED, publish, markPublished, scheduleRetry com backoff) e o worker de PENDING_REFERENCE (backoff exponencial, limite de tentativas, REJECTED com REFERENCE_NOT_FOUND e evento ao esgotar).
Restrições: nunca publicar antes do commit; vários publishers concorrentes sem perder nem duplicar indefinidamente; ordem de lock wallet → transação no worker; o reprocessamento reutiliza a lógica do use case.
Pronto quando: testes de integração provam dois publishers na mesma outbox, commit + morte antes de publicar → outra instância publica, publicação duplicada segura, REFUND/ROLLBACK chegando antes da referência, e limite de tentativas; `bun test` e `bunx tsc --noEmit` passam; checklist marcado; limite/TTL justificado no ARCHITECTURE.md.
Antes de codar: me mostre o plano e as dúvidas.
```

### Prompt — Fase 8 (Sonnet · medium)

```
Contexto: estamos na fase 8 do @docs/PLAN.md. Leia @CLAUDE.md, @ARCHITECTURE.md (seção 10) e @docs/CHALLENGE.md seção 12.
Objetivo: logs JSON estruturados com correlationId propagado (HTTP/SQS → use case → evento), métricas em /metrics (transações por status, duplicatas, retries, DLQ, conflitos/timeout de lock, outbox lag, latência), /health/ready checando Postgres e SQS, e reconciliação logando e contando divergências.
Restrições: nada de payload financeiro completo nem dados sensíveis nos logs; health sem autenticação; não mudar regras de negócio.
Pronto quando: um teste verifica as métricas principais e os health checks; uma amostra de log mostra os campos de contexto; `bun test` e `bunx tsc --noEmit` passam; checklist marcado.
Antes de codar: me mostre o plano e as dúvidas.
```

### Prompt — Fase 9 (Sonnet · medium)

```
Contexto: estamos na fase 9 do @docs/PLAN.md. Leia @CLAUDE.md, @ARCHITECTURE.md e @docs/CHALLENGE.md seções 13 e 14.
Objetivo: finalizar o README.md (requisitos, setup, comandos, como rodar cada suíte) e o ARCHITECTURE.md (decisões, trade-offs, limitações, desenho de autenticação), e fazer uma auditoria item a item contra as falhas eliminatórias e a tabela de avaliação, listando evidências (arquivo/teste) para cada item.
Restrições: não mudar comportamento sem me perguntar; documentação honesta (limitações explícitas).
Pronto quando: um clone limpo sobe e passa os testes seguindo só o README; a auditoria não mostra lacunas (ou as lacunas estão documentadas); `bun test` e `bunx tsc --noEmit` passam; checklist marcado. Depois rodo /code-review.
Antes de codar: me mostre o plano e as dúvidas.
```
