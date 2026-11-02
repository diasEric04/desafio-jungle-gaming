import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every guarantee the application relies on is enforced HERE, not only in code:
 *
 *  - uniqueness: one wallet per (player, currency); one transaction per idempotency key and per
 *    (provider, external id); one ledger entry per (wallet, version) and per (transaction, wallet);
 *    at most one processed reversal per reference; one inbox row per (consumer, message).
 *  - non-negativity: wallets.balance >= 0, ledger balances >= 0, amounts > 0.
 *  - immutability: ledger is append-only (UPDATE / DELETE / TRUNCATE raise); terminal transactions and
 *    their business columns cannot change; wallet identity columns and the version rule are guarded;
 *    outbox payloads cannot be edited.
 *  - balance == ledger: a deferred constraint trigger refuses to COMMIT a wallet whose balance and
 *    version do not match its latest ledger entry.
 */
export class Migration20261031000001InitialSchema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(20,2) NOT NULL,
        version     integer       NOT NULL,
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      )`);

    // ------------------------------------------------------------------ wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       varchar(64)   NOT NULL,
        external_transaction_id           varchar(128)  NOT NULL,
        idempotency_key                   varchar(256)  NOT NULL,
        payload_hash                      char(64)      NOT NULL,
        wallet_id                         uuid          NOT NULL REFERENCES wallets (id),
        player_id                         uuid          NOT NULL,
        round_id                          varchar(128)  NOT NULL,
        game_id                           varchar(128)  NOT NULL,
        kind                              varchar(16)   NOT NULL,
        amount                            numeric(20,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid REFERENCES wager_transactions (id),
        status                            varchar(24)   NOT NULL,
        failure_code                      varchar(48),
        observed_balance                  numeric(20,2),
        reference_attempts                integer       NOT NULL DEFAULT 0,
        next_attempt_at                   timestamptz,
        lease_until                       timestamptz,
        created_at                        timestamptz   NOT NULL,
        updated_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT wager_tx_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_tx_amount_positive_unless_loss CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT wager_tx_hash_format CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        CONSTRAINT wager_tx_reversal_has_reference CHECK (
          kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_bet_has_no_reference CHECK (
          kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_tx_opening_is_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT wager_tx_processed_complete CHECK (
          status <> 'PROCESSED' OR (processed_at IS NOT NULL AND observed_balance IS NOT NULL)),
        CONSTRAINT wager_tx_failure_has_code CHECK (
          status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_pending_has_schedule CHECK (
          status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
      )`);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at)`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_due_idx ON wager_transactions (next_attempt_at)
      WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_dependents_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
      WHERE status = 'PENDING_REFERENCE'`);
    // A transaction can be reversed by at most one PROCESSED REFUND/ROLLBACK, enforced by the schema.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);

    // ------------------------------------------------------------------ wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid PRIMARY KEY,
        wallet_id      uuid          NOT NULL REFERENCES wallets (id),
        transaction_id uuid          NOT NULL REFERENCES wager_transactions (id),
        direction      varchar(6)    NOT NULL,
        amount         numeric(20,2) NOT NULL,
        currency       char(3)       NOT NULL,
        balance_before numeric(20,2) NOT NULL,
        balance_after  numeric(20,2) NOT NULL,
        wallet_version integer       NOT NULL,
        created_at     timestamptz   NOT NULL,
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_transaction_wallet_uq UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount))
      )`);

    // ------------------------------------------------------------------ inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(128) NOT NULL,
        message_id    varchar(256) NOT NULL,
        payload_hash  char(64)     NOT NULL,
        received_at   timestamptz  NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid PRIMARY KEY,
        aggregate_id    uuid         NOT NULL,
        event_type      varchar(128) NOT NULL,
        payload         jsonb        NOT NULL,
        occurred_at     timestamptz  NOT NULL,
        attempts        integer      NOT NULL DEFAULT 0,
        next_attempt_at timestamptz  NOT NULL,
        published_at    timestamptz,
        last_error      varchar(500)
      )`);
    this.addSql(`
      CREATE INDEX outbox_pending_idx ON outbox_messages (occurred_at)
      WHERE published_at IS NULL`);

    // ------------------------------------------------------------------ guards (triggers)
    this.addSql(`
      CREATE FUNCTION wagering_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wagering_forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wagering_forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete
        BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wagering_forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER wallets_no_delete
        BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wagering_forbid_mutation()`);

    this.addSql(`
      CREATE FUNCTION wager_transactions_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is % and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.provider_id <> OLD.provider_id
           OR NEW.external_transaction_id <> OLD.external_transaction_id
           OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.wallet_id <> OLD.wallet_id OR NEW.player_id <> OLD.player_id
           OR NEW.round_id <> OLD.round_id OR NEW.game_id <> OLD.game_id OR NEW.kind <> OLD.kind
           OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'business columns of wager transaction % are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
          RAISE EXCEPTION 'wager transaction % cannot go back to PENDING', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_update
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard_update()`);

    this.addSql(`
      CREATE FUNCTION wallets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
           OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'identity columns of wallet % are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance <> OLD.balance THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet % balance changed without version + 1 (% -> %)', OLD.id, OLD.version, NEW.version
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version may only change together with the balance', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallets_guard_update
        BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard_update()`);

    // Deferred: checked at COMMIT, so balance, version and ledger entry may be written in any order.
    this.addSql(`
      CREATE FUNCTION wallets_assert_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        last_after   numeric(20,2);
        last_version integer;
      BEGIN
        SELECT balance_after, wallet_version INTO last_after, last_version
          FROM wallet_ledger_entries WHERE wallet_id = NEW.id
          ORDER BY wallet_version DESC LIMIT 1;
        IF NOT FOUND THEN
          IF NEW.balance <> 0 OR NEW.version <> 1 THEN
            RAISE EXCEPTION 'wallet % has balance % / version % but no ledger entries', NEW.id, NEW.balance, NEW.version
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF last_after <> NEW.balance OR last_version <> NEW.version THEN
          RAISE EXCEPTION 'wallet % (balance %, version %) disagrees with its ledger (balance %, version %)',
            NEW.id, NEW.balance, NEW.version, last_after, last_version
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_assert_ledger_consistency()`);

    this.addSql(`
      CREATE FUNCTION outbox_messages_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.published_at IS NOT NULL THEN
          RAISE EXCEPTION 'outbox message % was already published', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.aggregate_id <> OLD.aggregate_id OR NEW.event_type <> OLD.event_type
           OR NEW.payload <> OLD.payload OR NEW.occurred_at <> OLD.occurred_at THEN
          RAISE EXCEPTION 'outbox message % content is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER outbox_messages_guard_update
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_messages_guard_update()`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS outbox_messages_guard_update()`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_assert_ledger_consistency()`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_guard_update()`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_transactions_guard_update()`);
    this.addSql(`DROP FUNCTION IF EXISTS wagering_forbid_mutation()`);
  }
}
