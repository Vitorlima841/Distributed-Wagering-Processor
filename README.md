# Distributed Wagering Processor

Serviço financeiro distribuído que processa apostas (BET/WIN/LOSS/REFUND/ROLLBACK) de múltiplos
provedores. NestJS + Bun + TypeScript estrito + MikroORM + PostgreSQL + SQS (LocalStack).

Enunciado: [docs/CHALLENGE.md](docs/CHALLENGE.md) · Plano: [docs/PLAN.md](docs/PLAN.md) ·
Decisões: [ARCHITECTURE.md](ARCHITECTURE.md)

> Estado atual: **fase 7** (domínio, persistência, use cases, API HTTP, suíte de concorrência,
> consumer SQS com inbox, retry/DLQ e shutdown gracioso, outbox publisher e worker de
> PENDING_REFERENCE). Observabilidade (fase 8) ainda não.

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose

## Setup

```bash
bun install
cp .env.example .env        # opcional: os testes já têm defaults para o compose local
docker compose up -d        # postgres + localstack + app
curl http://localhost:3000/health/live
```

`docker compose up -d` sobe:

| Serviço | Porta no host | Observação |
|---|---|---|
| `postgres` | **5433** | usuário/senha/banco: `wagering` (5433 para não colidir com um Postgres local na 5432) |
| `localstack` | 4566 | cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 recebimentos) e `wagering-events` |
| `app` | 3000 | roda as migrations e sobe o papel definido em `ROLE` (padrão `all`) |

Para rodar só a infraestrutura e a aplicação no host:

```bash
docker compose up -d postgres localstack
bun run migration:up
bun run dev
```

## Papéis (`ROLE`)

`api` · `consumer` · `outbox` · `pending-ref` · `all` (padrão). Todo processo expõe HTTP
(`/health/live`).

```bash
ROLE=api docker compose up -d app
```

### Consumer SQS

O papel `consumer` (incluído em `all`) lê `wager-transactions.fifo` e chama o mesmo use case do
`POST /wagering/transactions`. Mensagem (seção 10 do desafio; `data` é o corpo do POST mais a
`idempotencyKey`, obrigatória):

```bash
docker compose exec localstack awslocal sqs send-message   --queue-url http://localhost:4566/000000000000/wager-transactions.fifo   --message-group-id <walletId> --message-deduplication-id msg-123   --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-123","idempotencyKey":"provider-a:transaction-123","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

Resultado de negócio (inclusive REJECTED e PENDING_REFERENCE) → ack; falha transitória → volta com
backoff (2s, 4s, 8s… até 60s) e, depois de 5 recebimentos, o SQS move para
`wager-transactions-dlq.fifo`; mensagem inválida, conflito ou wallet inexistente → DLQ na hora, com
o motivo nos atributos `failure-kind` / `failure-code`. Detalhes em
[ARCHITECTURE.md §9 e §18](ARCHITECTURE.md).

### Outbox publisher e worker de PENDING_REFERENCE

- `outbox`: publica `outbox_messages` na fila standard `wagering-events`, em lotes travados com
  `FOR UPDATE SKIP LOCKED` (vários publishers não pegam a mesma linha). Só enxerga o que já foi
  confirmado; se morrer antes do COMMIT, outra instância publica. Garantia at-least-once: o
  consumidor deduplica pelo `eventId` (corpo e atributo `event-id`). Falha ao publicar → backoff
  1s, 2s, 4s… até 60s, sem desistir.
- `pending-ref`: reprocessa REFUND/ROLLBACK que chegaram antes da referência, travando a wallet antes
  da transação, com backoff 1s, 2s, 4s… (teto 60s). Na 10ª tentativa sem referência (~5 min depois da
  chegada) a transação vira `REJECTED` / `REFERENCE_NOT_FOUND` e emite `WagerTransactionRejected`.

Para ler os eventos publicados no ambiente local:

```bash
docker compose exec localstack awslocal sqs receive-message --queue-url http://localhost:4566/000000000000/wagering-events --max-number-of-messages 10 --message-attribute-names All
```

Detalhes em [ARCHITECTURE.md §9 e §19](ARCHITECTURE.md).

## Configuração (variáveis de ambiente)

Validadas na inicialização; o processo encerra com a lista de erros se algo estiver inválido.
Veja [.env.example](.env.example).

## Comandos

| Comando | O que faz |
|---|---|
| `bun test` | todos os testes (integração e concorrência exigem `docker compose up -d postgres localstack`) |
| `bun run test:unit` | testes unitários (sem infraestrutura) |
| `bun run test:integration` | integração contra Postgres/LocalStack reais (inclui `test/integration/sqs`) |
| `bun run test:concurrency` | concorrência: sobe 3 instâncias reais da aplicação (processos separados) contra o Postgres |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `lint:fix` | Biome |
| `bun run migration:up` / `migration:down` | aplica / reverte uma migration |

Os testes de integração usam o banco `wagering_test` (no mesmo Postgres do compose), criado e migrado
automaticamente na primeira execução. O ledger é append-only, então os testes não limpam tabelas: cada um
usa ids novos. Para recomeçar do zero: `docker compose exec postgres dropdb -U wagering wagering_test`.

### Testes de concorrência

`test/concurrency` sobe, por arquivo, **3 processos** `bun src/main.ts` (`ROLE=api`, porta efêmera,
banco `wagering_test`) e fala HTTP com eles; o único estado compartilhado é o Postgres. Para provar
que as requisições estavam mesmo em paralelo, o teste trava a wallet numa conexão própria, dispara
as requisições pelas 3 instâncias e só solta o lock quando o `pg_stat_activity` mostra todas
esperando por ele (cada instância tem um `application_name` próprio). Cobrem: a mesma aposta 50x,
o cenário obrigatório (100.00 e duas BET de 80.00), hot wallet, wallets distintas em paralelo,
queda de instâncias (kill sem aviso) e reinício completo. Detalhes em
[ARCHITECTURE.md §4 e §17](ARCHITECTURE.md). Precisam só de `docker compose up -d postgres localstack`.

`consumer-crash.test.ts` sobe consumers como processos (`ROLE=consumer`): um é morto depois do
COMMIT e antes do ack (um proxy na frente do LocalStack segura o `DeleteMessage`) e outro recebe a
reentrega sem repetir o efeito; três consumers processam juntos uma carga com mensagens duplicadas.

`outbox-publishers.test.ts` e `pending-reference-workers.test.ts` sobem publishers (`ROLE=outbox`) e
workers (`ROLE=pending-ref`) como processos, num **banco descartável** próprio (os workers leem a
tabela inteira, e o `wagering_test` acumula eventos e pendências de outras suítes): dois publishers na
mesma outbox, publisher morto antes de publicar, publicação duplicada deduplicada pelo consumidor e
dois workers disputando as mesmas PENDING_REFERENCE.

### Testes do consumer SQS

`test/integration/sqs` usa o LocalStack real com **filas próprias por arquivo** (criadas e apagadas
pelo teste), para não disputar mensagens com o container `app`. Cobrem inbox e atomicidade, reentrega,
duas instâncias com a mesma mensagem, backoff, redrive para a DLQ após 5 recebimentos, erros
permanentes e shutdown gracioso. O teste com SIGTERM real num processo só roda em Linux/macOS (no
Windows `kill` encerra à força); para rodá-lo no Windows, use um container:

```bash
docker run --rm --network distributed-wagering-processor_default -v "$PWD:/app:ro" -v /app/node_modules -e DATABASE_URL=postgres://wagering:wagering@postgres:5432/wagering_test -e SQS_ENDPOINT=http://localstack:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test distributed-wagering-processor-app bun test test/integration/sqs/shutdown.test.ts
```

(usa a imagem do `app`, que já tem as dependências instaladas para Linux).

## Estrutura

```
src/
  domain/          # TS puro (sem NestJS/MikroORM/AWS)
  application/     # use cases + ports
  infrastructure/  # config, MikroORM (records, mappers, repositórios, UnitOfWork), logger, cliente SQS
  interfaces/      # HTTP, consumer SQS (interfaces/sqs), contratos compartilhados, workers
migrations/        # reversíveis (up/down), registradas em mikro-orm.config.ts
test/{unit,integration,concurrency}
docker/localstack/ # init das filas
```
