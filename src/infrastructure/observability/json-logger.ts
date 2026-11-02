import type { LogFields, Logger } from '@/application/ports/services';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

/** Keys whose values are never written to logs (money, payloads, credentials). */
const SENSITIVE_KEY =
  /^(amount|money|balance|balanceBefore|balanceAfter|payload|body|data|authorization|password|token|secret|accessKeyId|secretAccessKey)$/i;
const MAX_DEPTH = 3;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1);
  }
  return out;
}

/**
 * Structured JSON logger (one object per line on stdout). Context ids (correlationId, messageId,
 * transactionId, walletId, providerId) are plain fields; monetary values and payloads are redacted.
 */
export class JsonLogger implements Logger {
  constructor(
    private readonly level: Level | 'silent',
    private readonly bindings: LogFields = {},
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  debug(message: string, fields?: LogFields): void {
    this.log('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.log('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.log('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.log('error', message, fields);
  }

  child(bindings: LogFields): Logger {
    return new JsonLogger(this.level, { ...this.bindings, ...bindings }, this.write);
  }

  private log(level: Level, message: string, fields?: LogFields): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const entry = {
      level,
      time: new Date().toISOString(),
      msg: message,
      ...this.bindings,
      ...fields,
    };
    this.write(JSON.stringify(redact(entry)));
  }
}
