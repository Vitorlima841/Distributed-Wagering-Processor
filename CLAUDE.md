# CLAUDE.md — Distributed Wagering Processor

Desafio técnico: serviço financeiro distribuído que processa apostas (BET/WIN/LOSS/REFUND/ROLLBACK)
vindas de múltiplos provedores. Enunciado completo: `docs/CHALLENGE.md`.
Plano e progresso: `docs/PLAN.md`. Decisões técnicas: `ARCHITECTURE.md`.

**Ao iniciar uma sessão:** leia `docs/PLAN.md` para saber em que fase estamos e o que já foi feito.

## Stack obrigatória

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | **Bun 1.x** (`bun install`, `bun test`, `bun run`) |
| Linguagem | **TypeScript** em modo estrito (`"strict": true`) — nada de `.js` no código-fonte |
| Framework | **NestJS** |
| ORM | **MikroORM** (driver `@mikro-orm/postgresql`) — Prisma e outros ORMs estão proibidos |
| Banco | **PostgreSQL** |
| Mensageria | **AWS SQS** via **LocalStack** (`@aws-sdk/client-sqs`) |
| Orquestração local | **Docker Compose** |
| Migrations | versionadas e reversíveis (`up` e `down`) |
| Dinheiro | `decimal.js` no domínio, `numeric(20,2)` no banco |

## Arquitetura: hexagonal (Ports & Adapters) + DDD

```
src/
  domain/          # TS puro: Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, erros
  application/     # use cases + ports (interfaces de repositórios, publisher, clock, id generator)
  infrastructure/  # adapters: MikroORM (schemas, mappers, repos), SQS, outbox, métricas, logs
  interfaces/      # entradas: controllers HTTP, consumer SQS, workers agendados
migrations/
test/
  unit/  integration/  concurrency/
```

Regras de dependência (setas só apontam para dentro):

- `domain` não importa **nada** de fora dele: nem NestJS, nem MikroORM, nem AWS SDK.
- `application` importa só `domain` e define ports; não conhece MikroORM nem SQS.
- `infrastructure` e `interfaces` implementam ports e chamam use cases.
- HTTP e consumer SQS chamam **o mesmo use case** (`ProcessWagerTransaction`).

## Restrições invioláveis (copiadas da seção 5 do desafio)

1. Não usar `number`, `float` ou `double` para dinheiro.
2. Não usar cache em memória como garantia de idempotência.
3. Não confiar apenas em SQS FIFO para garantir consistência.
4. Não publicar eventos antes do commit da transação financeira.
5. Não sobrescrever nem excluir lançamentos do ledger.
6. Não usar lock global compartilhado por todas as wallets.
7. Não implementar saldo como `read → calculate → update` sem controle de concorrência.
8. A solução deve estar correta com **múltiplas instâncias** da aplicação.
9. As garantias de unicidade, imutabilidade e não-negatividade descritas na seção 6 devem ser aplicadas **no schema do banco**, não apenas em código de aplicação. O desenho do schema, das constraints e dos índices é parte do que está sendo avaliado.

## Falhas eliminatórias (copiadas da seção 14 do desafio)

- `number` para dinheiro;
- saldo negativo causado por race;
- débito ou crédito duplicado;
- idempotência apenas em memória;
- solução correta somente com uma instância;
- publicação de evento antes do commit;
- ausência de ledger auditável;
- testes que substituem completamente PostgreSQL e SQS por mocks.

## Regras de trabalho

- **Antes de dizer que terminou:** rode `bun test` e `bunx tsc --noEmit` e mostre o resultado. Se algo falhar, diga.
- **Nunca use `number` para dinheiro** — nem em DTO, nem em entidade, nem em teste. Valores trafegam como string decimal com 2 casas (`"25.00"`).
- **O domínio não importa NestJS nem MikroORM.** Persistência usa `EntitySchema`/mappers na infraestrutura.
- Classes de domínio: construtor `private` + factories estáticas (`create`/`open`/`from`, `rehydrate`). `rehydrate` não revalida transições.
- Toda garantia importante existe **no banco** (constraint, índice único, CHECK, trigger) e **no código**.
- Inbox, alteração de saldo, ledger, transação e outbox gravam na **mesma transação SQL**.
- **Ordem de lock fixa:** primeiro a linha da `wallets` (`FOR UPDATE`), depois a da `wager_transactions`. Nunca o contrário (evita deadlock).
- Testes de integração e concorrência rodam contra **Postgres e LocalStack reais** (docker compose). Mocks só em teste unitário.
- Todo teste de integração/concorrência termina verificando `wallet.balance == saldo reconstruído pelo ledger`.
- Logs estruturados (JSON) sem payload financeiro completo nem dados sensíveis.
- Trabalhe em passos pequenos. Se o enunciado for ambíguo, **pergunte** ou registre a interpretação em `ARCHITECTURE.md`.
- Ao concluir uma fase: marque o checklist em `docs/PLAN.md` e anote decisões novas em `ARCHITECTURE.md`.
- Não faça commit sem o usuário pedir.

## Comandos

```bash
bun install
docker compose up -d                  # postgres (host :5433) + localstack (:4566) + app (:3000)
docker compose up -d postgres localstack   # só a infra, para rodar testes/app no host
bun test                              # todos os testes (integração exige a infra acima)
bun run test:unit | test:integration | test:concurrency
bunx tsc --noEmit                     # checagem de tipos
bun run lint                          # Biome (lint:fix para corrigir)
bun run migration:up | migration:down # migrations MikroORM (registrar novas em mikro-orm.config.ts)
```

Convenções do scaffold: DI do Nest sempre com `@Inject(Token)` explícito (o Bun não garante
`emitDecoratorMetadata`); migrations entram em `migrationsList` (sem glob).
