# Distributed Wagering Processor

Serviço financeiro distribuído que processa apostas (BET/WIN/LOSS/REFUND/ROLLBACK) de múltiplos
provedores, correto com entregas duplicadas, fora de ordem e simultâneas, e com várias instâncias.
Stack: NestJS + Bun + TypeScript estrito + MikroORM + PostgreSQL + SQS (LocalStack).

| Documento | Conteúdo |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | decisões, trade-offs, limitações, desenho de autenticação |
| [docs/AUDIT.md](docs/AUDIT.md) | auditoria contra o desafio: cada falha eliminatória e item avaliado, com o teste que o prova |
| [docs/CHALLENGE.md](docs/CHALLENGE.md) | enunciado |
| [docs/PLAN.md](docs/PLAN.md) | plano e checklist por fase |

**O que existe:** API HTTP (wallets, transações, consultas, ledger paginado, reconciliação), consumer SQS
com inbox, retry, DLQ e shutdown gracioso, outbox publisher, worker de PENDING_REFERENCE, logs JSON com
correlação, `/metrics` e health checks. **Não implementado** (opcional no desafio): autenticação (só o
ponto de extensão, [ARCHITECTURE §11](ARCHITECTURE.md#11-autenticação)), teste de carga e ledger de
partidas dobradas.

## Requisitos

| Ferramenta | Versão | Observação |
|---|---|---|
| [Bun](https://bun.sh) | 1.x (testado com 1.4.4) | runtime, gerenciador de pacotes e test runner |
| Docker + Docker Compose | Compose v2 (testado com Docker 28 e Compose 2.33) | Postgres 16 e LocalStack 3.8 (imagem comunitária, sem token) |
| Portas livres no host | **5433** (Postgres), **4566** (LocalStack), **3000** (app) | a 5433 evita colidir com um Postgres local na 5432 |

Funciona em Linux, macOS e Windows. No Windows, um único teste (SIGTERM real num processo) é pulado.
Veja [Solução de problemas](#solução-de-problemas) para rodá-lo num container.

## Subir do zero

```bash
git clone https://github.com/Vitorlima841/Distributed-Wagering-Processor.git
```

```bash
cd Distributed-Wagering-Processor
```

```bash
bun install
```

```bash
docker compose up -d --build
```

`docker compose up -d --build` sobe:

| Serviço | Porta no host | O que faz |
|---|---|---|
| `postgres` | 5433 | usuário, senha e banco `wagering` |
| `localstack` | 4566 | cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 recebimentos) e `wagering-events` |
| `app` | 3000 | aplica as migrations e sobe o papel de `ROLE` (padrão `all`: API, consumer, outbox e worker) |

O `app` só sobe depois que o Postgres e as filas ficam prontos. Para conferir:

```bash
curl http://localhost:3000/health/ready
```

A resposta esperada é `{"status":"ready","checks":{"postgres":{"status":"up",…},"sqs":{"status":"up",…}}}`
(o check `sqs` cobre as filas de que o papel depende; com `ROLE=all`, as três). No
PowerShell do Windows, use `curl.exe` (o `curl` de lá é um alias de outro comando).

> Depois de um `git pull`, rode `docker compose up -d --build` de novo: sem `--build`, o `app` continua
> com a imagem antiga.

### Primeiras requisições

Criar uma wallet com saldo inicial (gera a transação interna `OPENING` e o lançamento de abertura):

```bash
curl -s -X POST http://localhost:3000/wallets -H 'Content-Type: application/json' -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Apostar, usando o `id` devolvido como `walletId`:

```bash
curl -s -X POST http://localhost:3000/wagering/transactions -H 'Content-Type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

A primeira resposta é `201` com `"idempotentReplay": false`. Repetir o mesmo comando devolve `200` com
o mesmo resultado e `"idempotentReplay": true`. A mesma key com outro payload dá `409`. Uma segunda
wallet para o mesmo `playerId` + moeda também dá `409`, com o `walletId` existente. O mapeamento
completo de status está em [ARCHITECTURE §8](ARCHITECTURE.md#8-mapeamento-http).

Outras rotas: `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger?cursor=&limit=`,
`POST /wallets/:walletId/reconciliation`, `GET /wagering/transactions/:transactionId`,
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`.

## Testes

Os testes de integração e de concorrência rodam contra **Postgres e LocalStack reais**. Basta a
infraestrutura do compose; o `app` pode estar de pé ou não:

```bash
docker compose up -d postgres localstack
```

```bash
bun test
```

Resultado esperado: tudo passa, com **1 teste pulado no Windows** (SIGTERM real). Leva cerca de
2 minutos, porque sobe processos reais e espera backoffs reais do SQS. Referência num clone limpo
(Windows 11, Docker Desktop): unitária ~2 s (321 testes), integração ~70 s (206 + 1 pulado), concorrência
~50 s (18).

| Suíte | Comando | Precisa de | O que cobre |
|---|---|---|---|
| Unitária | `bun run test:unit` | nada | domínio (`Money`, `Wallet`, `WagerTransaction`, regras de referência, hash do payload, eventos), classificação de erros, cursor, loop do consumer e dos workers |
| Integração | `bun run test:integration` | Postgres + LocalStack | migrations up/down, cada constraint do schema, repositórios e UnitOfWork, cada regra de negócio pela API, idempotência e corridas, atomicidade com falha injetada, consumer SQS (inbox, redelivery, retry, DLQ, shutdown), outbox publisher, worker de PENDING_REFERENCE, métricas, logs e health |
| Concorrência | `bun run test:concurrency` | Postgres + LocalStack | 3 instâncias reais (processos) contra o mesmo Postgres: mesma aposta 50x, cenário obrigatório (100.00 e duas BET de 80.00), hot wallet, wallets distintas, quedas e reinício, consumer morto entre o COMMIT e o ack, dois publishers, dois workers |

Para rodar um arquivo só: `bun test test/concurrency/mandatory-scenario.test.ts`.

Todo teste de integração ou concorrência que cria wallets termina conferindo
`wallet.balance == saldo reconstruído pelo ledger`.

### Bancos e filas dos testes

- Os testes usam o banco **`wagering_test`** (no mesmo Postgres do compose), criado e migrado
  automaticamente na primeira execução. O banco `wagering` do `app` não é tocado.
- O ledger é append-only, então os testes não limpam tabelas: cada um usa ids novos.
- Os testes de migrations, de health, de observabilidade, do outbox publisher e do worker de
  PENDING_REFERENCE criam um **banco descartável** próprio, porque os workers leem a tabela inteira.
- Os testes de SQS criam **filas próprias por arquivo** e as apagam no fim. Assim não disputam mensagens
  entre si nem com o container `app`.
- Os defaults (`localhost:5433`, `localhost:4566`, credenciais `test`) ficam em `test/setup.ts`, e
  qualquer variável de ambiente definida os substitui.

### Como a concorrência é provada

`test/concurrency` sobe, por arquivo, **3 processos** `bun src/main.ts` (`ROLE=api`, porta efêmera) e fala
HTTP com eles. O único estado compartilhado é o Postgres. Para provar que as requisições estavam mesmo em
paralelo, o teste trava a wallet numa conexão própria, dispara as requisições pelas 3 instâncias e só
solta o lock quando o `pg_stat_activity` mostra todas esperando por ele (cada instância tem um
`application_name` próprio). Nenhum sleep fixo. Detalhes em
[ARCHITECTURE §4 e §17](ARCHITECTURE.md#4-concorrência).

- `consumer-crash.test.ts` sobe consumers como processos (`ROLE=consumer`). Um é morto depois do COMMIT
  e antes do ack (um proxy na frente do LocalStack segura o `DeleteMessage`), e outro recebe a reentrega
  sem repetir o efeito. Três consumers processam juntos uma carga com mensagens duplicadas.
- `outbox-publishers.test.ts` e `pending-reference-workers.test.ts` sobem publishers (`ROLE=outbox`) e
  workers (`ROLE=pending-ref`) como processos: dois publishers na mesma outbox, publisher morto antes de
  publicar, publicação duplicada deduplicada pelo consumidor e dois workers disputando as mesmas
  PENDING_REFERENCE.

## Papéis (`ROLE`)

A mesma imagem roda em papéis diferentes: `api`, `consumer`, `outbox`, `pending-ref` ou `all` (padrão).
Todo papel expõe HTTP com `/health/live`, `/health/ready` e `/metrics`.

```bash
ROLE=api docker compose up -d app
```

### Consumer SQS

O papel `consumer` lê `wager-transactions.fifo` e chama o mesmo use case do `POST /wagering/transactions`.
O `data` da mensagem é o corpo do POST mais a `idempotencyKey`, obrigatória:

```bash
docker compose exec localstack awslocal sqs send-message --queue-url http://localhost:4566/000000000000/wager-transactions.fifo --message-group-id <walletId> --message-deduplication-id msg-123 --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

- Resultado de negócio (inclusive REJECTED e PENDING_REFERENCE) → ack.
- Falha transitória → a mensagem volta com backoff (2s, 4s, 8s… até 60s). Depois de 5 recebimentos, o
  SQS a move para `wager-transactions-dlq.fifo`.
- Mensagem inválida, conflito ou wallet inexistente → DLQ na hora, com o motivo nos atributos
  `failure-kind` e `failure-code`.

Detalhes em [ARCHITECTURE §9 e §18](ARCHITECTURE.md#9-mensageria).

### Outbox publisher e worker de PENDING_REFERENCE

- `outbox`: publica `outbox_messages` na fila standard `wagering-events`, em lotes travados com
  `FOR UPDATE SKIP LOCKED`. Só enxerga o que já foi confirmado. A garantia é at-least-once: o
  consumidor deduplica pelo `eventId` (no corpo e no atributo `event-id`).
- `pending-ref`: reprocessa REFUND/ROLLBACK que chegaram antes da referência, com backoff 1s, 2s, 4s…
  (teto 60s). Na 10ª tentativa sem referência (~5 min depois da chegada), a transação vira `REJECTED` /
  `REFERENCE_NOT_FOUND` e emite `WagerTransactionRejected`.

Para ler os eventos publicados:

```bash
docker compose exec localstack awslocal sqs receive-message --queue-url http://localhost:4566/000000000000/wagering-events --max-number-of-messages 10 --message-attribute-names All
```

## Observabilidade

- `GET /health/live`: o processo está de pé. `GET /health/ready`: Postgres e as filas de que o papel
  depende; responde 503 se uma dependência cair e durante o shutdown. Nenhum dos dois exige autenticação.
- `GET /metrics`: formato Prometheus. Inclui transações por status, duplicatas, erros, conflitos de
  lock, retries, DLQ, outbox lag, latência e divergências de reconciliação.
- Logs JSON no stdout, com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`,
  sem valores nem saldos. Mande `X-Correlation-Id` na requisição para escolher a correlação: ela é
  devolvida no header e segue até os eventos publicados.

```bash
curl http://localhost:3000/metrics
```

```bash
docker compose logs -f app
```

Lista de métricas e amostra de log: [ARCHITECTURE §10](ARCHITECTURE.md#10-observabilidade).

## Configuração

Variáveis de ambiente validadas na inicialização. Se algo estiver inválido, o processo encerra com a
lista de erros. Todas têm default, documentado em [.env.example](.env.example). Para rodar a aplicação no
host em vez do container:

```bash
cp .env.example .env
```

```bash
docker compose up -d postgres localstack
```

```bash
bun run migration:up
```

```bash
bun run dev
```

Se o container `app` também estiver de pé, pare-o antes (`docker compose stop app`), porque os dois usam
a porta 3000 e as mesmas filas.

## Comandos

| Comando | O que faz |
|---|---|
| `bun install` | instala as dependências |
| `docker compose up -d --build` | sobe Postgres, LocalStack e o `app` (reconstruindo a imagem) |
| `docker compose up -d postgres localstack` | só a infraestrutura (testes, ou app no host) |
| `bun test` | todos os testes |
| `bun run test:unit` · `test:integration` · `test:concurrency` | uma suíte |
| `bun run typecheck` (ou `bunx tsc --noEmit`) | checagem de tipos |
| `bun run lint` · `lint:fix` | Biome |
| `bun run dev` · `start` | sobe a aplicação no host (com e sem watch) |
| `bun run migration:up` · `migration:down` | aplica todas / reverte uma migration no banco de `DATABASE_URL` |
| `docker compose down` | para tudo (os dados ficam no volume `pgdata`) |
| `docker compose down -v` | para tudo e **apaga** os dados |

## Solução de problemas

- **Porta ocupada** (`bind: address already in use`): libere a 5433, a 4566 ou a 3000. As portas do
  host ficam no `docker-compose.yml`. Se mudar a do Postgres, defina `DATABASE_URL` ao rodar os testes.
- **O `app` não reflete o código atual:** `docker compose up -d --build`.
- **Recomeçar o banco de testes do zero:**

  ```bash
  docker compose exec postgres dropdb -U wagering --force wagering_test
  ```

- **Teste de SIGTERM no Windows:** ele é pulado no Windows (lá o `kill` encerra à força). Para rodá-lo,
  use a imagem do `app` (Linux), na rede do compose:

  ```bash
  docker compose run --rm --no-deps -e DATABASE_URL=postgres://wagering:wagering@postgres:5432/wagering_test app bun test test/integration/sqs/shutdown.test.ts
  ```

  A imagem precisa estar atualizada (`docker compose build app`).
- **Muitas conexões** nos testes de concorrência: eles abrem até 3 × 20 conexões. O Postgres do compose
  usa o padrão de 100.

## Estrutura

```
src/
  domain/          # TS puro (sem NestJS/MikroORM/AWS): Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos
  application/     # use cases + ports
  infrastructure/  # config, MikroORM (records, mappers, repositórios, UnitOfWork), SQS, logs, métricas, readiness
  interfaces/      # HTTP, consumer SQS, contratos compartilhados, workers
migrations/        # reversíveis (up/down), registradas em mikro-orm.config.ts
test/{unit,integration,concurrency,support}
docker/localstack/ # init das filas
docs/              # enunciado, plano, auditoria
```
