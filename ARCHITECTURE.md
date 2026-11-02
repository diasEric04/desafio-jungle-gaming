# ARCHITECTURE

## 1. Visão geral

```
 HTTP ──► Controller ─┐
                      ├─► ProcessWagerTransactionUseCase ──► PostgreSQL (wallet, ledger, transactions, inbox, outbox)
 SQS  ──► Consumer  ──┘                                             │
                                                                    ▼
                           OutboxPublisherWorker ◄── outbox_messages (SKIP LOCKED) ──► SQS events queue
                           PendingReferenceWorker ◄─ transações PENDING_REFERENCE (lease)
```

Uma instância pode rodar qualquer subconjunto dos três papéis (API, consumer, workers). Toda a coordenação
entre instâncias acontece **no PostgreSQL** (locks de linha, índices únicos, `SKIP LOCKED`); nenhum estado
correto vive em memória.

Camadas (dependências apontam para dentro):

- `domain/` e `application/` não importam NestJS nem MikroORM. A lógica de negócio é testável com fakes em memória.
- `infrastructure/` implementa as ports (`UnitOfWork`, repositórios, publisher) com MikroORM e AWS SDK.
- `interfaces/` expõe HTTP (NestJS) e traduz erros de domínio em status HTTP.

## 2. Decisões e trade-offs

| Decisão                                         | Motivo                                                                 | Custo                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **MikroORM** (Unit of Work + `EntitySchema`)    | exigido; migrations versionadas; `LockMode.PESSIMISTIC_WRITE`          | SQL cru (`em.execute`) onde o ORM atrapalha (`ON CONFLICT`, `SKIP LOCKED`) |
| Domínio sem decorators de ORM                   | domínio testável e independente; mapeamento explícito (`mappers.ts`)   | código de mapeamento                                                       |
| Lock pessimista por carteira + CAS de `version` | serializa débitos da mesma carteira; o CAS é defesa em profundidade    | carteira quente vira gargalo serial (inerente)                             |
| Idempotência _insert-first_                     | a corrida é decidida pelo índice único, não por "SELECT depois INSERT" | uma ida extra ao banco no replay                                           |
| Inbox + outbox em tabelas                       | at-least-once com efeito exatamente-uma-vez                            | retenção de linhas (ver §10)                                               |
| Sem autenticação                                | fora do escopo escolhido; ver §9                                       | —                                                                          |

## 3. Dinheiro

`Money` guarda **`bigint` em centavos** (escala fixa 2) + moeda. Nunca há `number` para valores monetários:
entrada é string decimal validada (`"12.34"`, no máximo 2 casas; `"1.234"` é 400), saída é string.
No banco: `BIGINT` em centavos com `CHECK (balance_cents >= 0)`. Operações são checadas (`Money.add/subtract`
rejeitam moedas diferentes e resultado negativo é erro de domínio).

## 4. Estratégia transacional

Uma única transação de banco por transação de aposta contém: registro de inbox (se veio do SQS), linha de
`wager_transactions`, mutação do `wallets`, lançamento em `wallet_ledger_entries` e linhas de `outbox_messages`.
Ou tudo ou nada.

Ordem de locks (fixa, evita deadlock): **carteira → transação**. O worker de referências pendentes segue a mesma ordem.

Passos do caso de uso:

1. `INSERT … ON CONFLICT DO NOTHING` da transação (chave: `idempotency_key` e `(provider_id, external_transaction_id)`).
2. Se já existia: compara `payload_hash`; igual → replay (200, devolve o resultado original, inclusive o saldo original); diferente → 409.
3. `SELECT … FOR UPDATE` da carteira; `WagerSettlement.settle` decide (puro, sem I/O).
4. Persistência atômica (`SettlementPersister`): ledger + saldo com `UPDATE … WHERE version = :expected` + status + outbox.
5. Deadlock / lock timeout / serialization failure → retry da transação inteira (`DB_TX_MAX_RETRIES`), contado em `wallet_lock_conflicts_total`.

### Garantias no schema (a última linha de defesa)

- `CHECK (balance >= 0)` e `CHECK (amount > 0)`.
- Ledger e transações **append-only** (triggers bloqueiam `UPDATE`/`DELETE` indevidos).
- `UNIQUE (wallet_id, wallet_version)` no ledger: versões contíguas e sem buraco.
- Constraint trigger _deferrable_ que, no commit, exige `wallets.balance == SUM(ledger)`.
- Índice único parcial: **no máximo uma reversão por transação de referência**.
- `UNIQUE (provider_id, external_transaction_id)`, `UNIQUE (idempotency_key)` e unicidade por consumidor/mensagem no inbox.
- `UNIQUE (transaction_id, wallet_id)` no ledger: uma transação nunca lança duas vezes na mesma carteira.

## 5. Idempotência e `payloadHash`

Duas camadas: HTTP (`Idempotency-Key`) e SQS (`messageId`, via inbox). `payloadHash` = SHA-256 do **JSON canônico**
(chaves ordenadas recursivamente, sem espaços, dinheiro normalizado) dos campos de negócio
(provider, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referência). Cabeçalhos,
correlation-id e ordem das chaves não entram. Mesma chave + hash diferente = `IDEMPOTENCY_CONFLICT` (409).

## 6. Estados e regras de negócio

```
RECEIVED ─► PROCESSED
        ├─► REJECTED            (regra de negócio; definitivo)
        ├─► PENDING_REFERENCE ─► PROCESSED | REJECTED   (referência chegou / expirou)
        └─► FAILED              (somente erro permanente inesperado no worker)
```

- BET debita; WIN credita; LOSS é registrada sem mover saldo; REFUND/ROLLBACK creditam o valor da BET referenciada.
- Códigos (`domain/wagering/failure-code.ts`): `INSUFFICIENT_FUNDS`, `ALREADY_REVERSED`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND` (após esgotar a espera), `REFERENCE_NOT_PROCESSED`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `INTERNAL_ERROR`. Rejeições de negócio são `REJECTED` (HTTP 422); cada código carrega uma dica de ação para o chamador (`FIX_PAYLOAD`, `SUBMIT_NEW_TRANSACTION_LATER`, `DO_NOT_RETRY`, `MANUAL_REVIEW`).

**Interpretações (escolhas explícitas):**

- No máximo **uma reversão por transação de referência, de qualquer tipo** (REFUND _ou_ ROLLBACK, nunca os dois). É mais estrito que o mínimo e elimina o duplo crédito entre os dois tipos.
- WIN/LOSS podem referenciar uma BET; WIN referenciando BET já revertida é rejeitado (`ALREADY_REVERSED`).
- Carteira inexistente **não** gera linha persistida: 404 no HTTP, DLQ no SQS.

## 7. Fora de ordem: `PENDING_REFERENCE`

REFUND/ROLLBACK cuja BET ainda não chegou ficam `PENDING_REFERENCE` (HTTP 202). O worker faz _claim_ por **lease**
(`FOR UPDATE SKIP LOCKED` + `lease_until`), então duas instâncias nunca pegam a mesma linha e um worker morto
perde o lease sozinho. Retentativas com backoff exponencial + jitter (`PendingReferencePolicy`); ao exceder
`PENDING_REFERENCE_MAX_ATTEMPTS` ou o TTL, vira `REJECTED(REFERENCE_NOT_FOUND)`. A reavaliação usa as mesmas regras do primeiro passe.

## 8. Mensageria

**Entrada (SQS FIFO):** `MessageGroupId = walletId` (ordem por carteira), dedup por `messageId`. O consumer só dá
ack **depois do commit**; se morre entre commit e ack, a redelivery bate no inbox e vira no-op. Erros transitórios
→ `ChangeMessageVisibility` com backoff; permanentes/envenenadas ou após `CONSUMER_MAX_ATTEMPTS` → DLQ
(redrive policy na fila + roteamento explícito). Shutdown gracioso: para de buscar, termina o que está em voo, só então encerra.

**Saída (outbox):** eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) são gravados
na mesma transação do efeito — nunca publicados antes do commit. O publisher usa `FOR UPDATE SKIP LOCKED`,
publica no SQS e marca `published_at`. Semântica **at-least-once**: se o processo morrer após o broker aceitar e antes
do commit, o evento sai de novo; consumidores deduplicam por `eventId` (dedup id do FIFO = `eventId`, o que cobre a janela de 5 min do SQS).

## 9. Autenticação (não implementada)

Decisão: fora do escopo. Extension point pronto: `AuthGuard` global (rotas `@Public()` isentas) +
`ProviderIdentityPort` (hoje `AllowAllProviderIdentity`). Desenho alvo: JWT de um IdP (Keycloak/Zitadel) validado
por JWKS, com `client_id` mapeado para `providerId`; o guard passa a **forçar** `providerId` do token e rejeitar
payloads de outro provider. Nenhuma mudança no domínio.

## 10. Observabilidade

Logs JSON com redação de campos sensíveis e `correlationId` (header `x-correlation-id`, propagado HTTP → SQS → eventos).
Métricas Prometheus em `/metrics`: `wager_transactions_total`, `wager_duplicates_total`, `wager_processing_duration_seconds`,
`wallet_lock_wait_seconds`, `wallet_lock_conflicts_total`, `outbox_lag_seconds`, `dlq_messages_total`, `retries_total`.
Health: `/health/live` (processo) e `/health/ready` (Postgres + filas).

## 11. Testes

| Nível              | O que cobre                                                                                                                                                   | Infra   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `test/unit`        | domínio, casos de uso (fakes em memória), config, classificação de erro, loop runner                                                                          | nenhuma |
| `test/integration` | schema/constraints/triggers, repositórios e casos de uso contra PG real, SQS real (LocalStack)                                                                | Docker  |
| `test/concurrency` | 3 processos reais: 50 duplicatas paralelas, carteira quente, 25 carteiras, fora de ordem, kill -9 antes do ack, publisher que morre, SIGKILL no meio de carga | Docker  |
| `test/load`        | throughput, p50/p95/p99, erros, conflitos de lock, lag do outbox → `load-test-report.md`                                                                      | Docker  |

Invariante verificada ao fim de cada cenário: `wallet.balance == saldo reconstruído do ledger`, versões contíguas.

## 12. Limitações conhecidas

- **Testes de integração/concorrência/carga não foram executados no ambiente em que o código foi escrito** (sem Docker/rede para registries). Só a camada unit foi executada. Detalhes de API do MikroORM e do LocalStack são o ponto mais provável de ajuste na primeira execução.
- Linhas de `outbox_messages` publicadas e do inbox não são removidas (falta job de retenção/particionamento).
- Ordem de publicação do outbox **não** é garantida globalmente (FIFO por `walletId` mitiga no consumidor, mas retries podem reordenar).
- A transação de banco permanece aberta durante o `send` ao SQS no publisher (simples e correto; limita throughput do publisher).
- Carteira quente é serializada pelo lock — limite inerente do modelo de saldo único.
