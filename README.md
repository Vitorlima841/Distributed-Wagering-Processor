# Distributed Wagering Processor

Serviço financeiro distribuído que processa apostas (BET/WIN/LOSS/REFUND/ROLLBACK) de múltiplos
provedores. NestJS + Bun + TypeScript estrito + MikroORM + PostgreSQL + SQS (LocalStack).

Enunciado: [docs/CHALLENGE.md](docs/CHALLENGE.md) · Plano: [docs/PLAN.md](docs/PLAN.md) ·
Decisões: [ARCHITECTURE.md](ARCHITECTURE.md)

> Estado atual: **fase 1** (scaffolding e infraestrutura). Ainda não há lógica de negócio.

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
(`/health/live`). Consumer, outbox e pending-ref são apenas casca nesta fase.

```bash
ROLE=api docker compose up -d app
```

## Configuração (variáveis de ambiente)

Validadas na inicialização; o processo encerra com a lista de erros se algo estiver inválido.
Veja [.env.example](.env.example).

## Comandos

| Comando | O que faz |
|---|---|
| `bun test` | todos os testes (os de integração exigem `docker compose up -d postgres localstack`) |
| `bun run test:unit` | testes unitários (sem infraestrutura) |
| `bun run test:integration` | integração contra Postgres/LocalStack reais |
| `bun run test:concurrency` | concorrência (a partir da fase 5) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `lint:fix` | Biome |
| `bun run migration:up` / `migration:down` | aplica / reverte uma migration |

## Estrutura

```
src/
  domain/          # TS puro (sem NestJS/MikroORM/AWS)
  application/     # use cases + ports
  infrastructure/  # config, MikroORM, logger, (SQS, outbox...)
  interfaces/      # HTTP, consumer SQS, workers
migrations/        # reversíveis (up/down), registradas em mikro-orm.config.ts
test/{unit,integration,concurrency}
docker/localstack/ # init das filas
```
