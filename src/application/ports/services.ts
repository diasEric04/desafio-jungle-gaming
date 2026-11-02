import { OutboxMessage } from '@/domain/messaging/outbox-message';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Time-ordered UUID (v7). */
  next(): string;
}

/** Publishes an outbox message to the broker. Must throw when the broker did not accept it. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

/**
 * Extension point for authentication (see ARCHITECTURE.md, "Authentication"). The default adapter
 * lets everything through; a Keycloak/Zitadel adapter would validate the bearer token and return the
 * provider the caller is allowed to act as.
 */
export interface ProviderIdentity {
  providerId: string | undefined;
}

export interface ProviderIdentityPort {
  authenticate(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<ProviderIdentity>;
}

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}
