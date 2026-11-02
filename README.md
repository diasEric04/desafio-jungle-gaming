# Distributed Wagering Processor

Processador de transações de apostas (BET / WIN / LOSS / REFUND / ROLLBACK) correto sob concorrência,
duplicidade, entrega fora de ordem, crash de processo e múltiplas instâncias.

Stack: **Bun · TypeScript strict · NestJS · MikroORM · PostgreSQL 16 · SQS FIFO (LocalStack) · Docker Compose**.

> Decisões, trade-offs e o modelo de consistência estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).
> O enunciado está em [`docs/CHALLENGE.md`](./docs/CHALLENGE.md).

## Subir tudo

```bash
cp .env.example .env            # opcional; o compose já injeta o necessário
docker compose up --build       # postgres + localstack + migrate + provision + 3 instâncias
```

| Serviço               | URL                                     |
| --------------------- | --------------------------------------- |
| app-1 / app-2 / app-3 | http://localhost:3001 / 3002 / 3003     |
| métricas (Prometheus) | `GET /metrics` em qualquer instância    |
| health                | `GET /health/live`, `GET /health/ready` |

Exemplo rápido:

```bash
curl -s -XPOST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -s -XPOST localhost:3001/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"<playerId>","walletId":"<walletId>","roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"30.00","currency":"BRL"}}'
```

## API

| Método | Rota                                 | Descrição                                                         |
| ------ | ------------------------------------ | ----------------------------------------------------------------- |
| POST   | `/wallets`                           | cria carteira (saldo inicial gera lançamento `OPENING` no ledger) |
| GET    | `/wallets/:id`                       | saldo e versão                                                    |
| GET    | `/wallets/:id/ledger?limit=&cursor=` | extrato paginado por cursor opaco                                 |
| POST   | `/wallets/:id/reconciliation`        | recalcula o saldo pelo ledger e compara com o armazenado          |
| POST   | `/wagering/transactions`             | processa uma transação (exige `Idempotency-Key`)                  |
| GET    | `/wagering/transactions/:id`         | consulta por id                                                   |

Status HTTP: `201` processada · `200` replay idempotente · `202` aguardando referência (`PENDING_REFERENCE`) ·
`400` payload inválido · `404` carteira inexistente · `409` conflito de idempotência · `422` rejeitada por regra de negócio.

## Comandos

| Comando                                              | O que faz                                                |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `bun install`                                        | dependências                                             |
| `bun run check`                                      | typecheck + lint + testes unitários                      |
| `bun run test:unit`                                  | unidade (sem infra; rápido)                              |
| `bun run infra:up`                                   | sobe só Postgres + LocalStack e provisiona filas         |
| `bun run test:integration`                           | integração com **PostgreSQL e SQS reais**                |
| `bun run test:concurrency`                           | concorrência com **3 processos `bun src/main.ts` reais** |
| `bun run test:load`                                  | carga; escreve `load-test-report.md`                     |
| `bun run migrate:up / migrate:down / migrate:status` | migrations reversíveis                                   |
| `bun run infra:down`                                 | derruba e apaga volumes                                  |

Rodando os testes localmente (fora do compose):

```bash
bun install
bun run infra:up
bun run test:unit && bun run test:integration && bun run test:concurrency
```

Os testes de integração/concorrência usam `DATABASE_URL` (padrão `postgres://wagering:wagering@localhost:5432/wagering`)
e LocalStack em `localhost:4566`; cada suíte cria filas com nome único.

## Estrutura

```
src/
  domain/          regras puras (Money, Wallet, WagerTransaction, WagerSettlement, eventos) — sem framework
  application/     casos de uso + ports (UnitOfWork, repositórios) — sem framework
  infrastructure/  MikroORM, migrations, SQS, workers, métricas, logger
  interfaces/      controllers NestJS, filtros, guard
  config/ shared/
test/
  unit/ integration/ concurrency/ load/ support/
scripts/           migrate, provision-queues
```

## Variáveis de ambiente

Todas listadas e comentadas em [`.env.example`](./.env.example). Cada instância pode ligar/desligar
`ENABLE_QUEUE_CONSUMER`, `ENABLE_OUTBOX_PUBLISHER` e `ENABLE_PENDING_REFERENCE_WORKER` independentemente.

## Limitações conhecidas

- Autenticação **não** implementada (extension point documentado no `ARCHITECTURE.md`).
- Os testes de unidade rodam sem infraestrutura; os de integração, concorrência e carga exigem Docker.
  Foram escritos junto com o código, mas **a primeira execução contra Postgres/LocalStack reais é sua**:
  ajustes finos (por exemplo, detalhes da API do MikroORM) podem aparecer nessa primeira rodada.
