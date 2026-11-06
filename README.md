# Distributed Wagering Processor

Serviço financeiro distribuído que processa apostas (BET/WIN/LOSS/REFUND/ROLLBACK) de múltiplos
provedores. NestJS + Bun + TypeScript estrito + MikroORM + PostgreSQL + SQS (LocalStack).

Enunciado: [docs/CHALLENGE.md](docs/CHALLENGE.md) · Plano: [docs/PLAN.md](docs/PLAN.md) ·
Decisões: [ARCHITECTURE.md](ARCHITECTURE.md)

> Estado atual: **fase 5** (domínio, persistência, use cases, API HTTP e suíte de concorrência).
> Consumer SQS, outbox publisher e worker de PENDING_REFERENCE ainda são casca (fases 6 e 7).

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

## Estrutura

```
src/
  domain/          # TS puro (sem NestJS/MikroORM/AWS)
  application/     # use cases + ports
  infrastructure/  # config, MikroORM (records, mappers, repositórios, UnitOfWork), logger, (SQS, outbox...)
  interfaces/      # HTTP, consumer SQS, workers
migrations/        # reversíveis (up/down), registradas em mikro-orm.config.ts
test/{unit,integration,concurrency}
docker/localstack/ # init das filas
```
