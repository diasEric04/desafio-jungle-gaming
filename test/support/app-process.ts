import { FAST_ENV } from './env';
import { waitFor } from './db';

export interface AppInstance {
  name: string;
  port: number;
  url: string;
  proc: ReturnType<typeof Bun.spawn>;
  kill(signal?: NodeJS.Signals): void;
  exited: Promise<number>;
}

let nextPort = 3400 + Math.floor(Math.random() * 400);

/** Boots a REAL, separate OS process running the whole app (`bun src/main.ts`). */
export async function startApp(
  name: string,
  env: Record<string, string> = {},
  options: { waitReady?: boolean } = {},
): Promise<AppInstance> {
  const port = nextPort++;
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, ...FAST_ENV, ...env, PORT: String(port), INSTANCE_ID: name },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const instance: AppInstance = {
    name,
    port,
    url: `http://127.0.0.1:${port}`,
    proc,
    kill: (signal = 'SIGKILL') => proc.kill(signal),
    exited: proc.exited,
  };
  if (options.waitReady ?? true) {
    await waitFor(
      async () => {
        try {
          const res = await fetch(`${instance.url}/health/ready`);
          return res.status === 200;
        } catch {
          return false;
        }
      },
      { timeoutMs: 40_000, what: `${name} to become ready` },
    );
  }
  return instance;
}

export async function http<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export interface SubmitInput {
  walletId: string;
  playerId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: string;
  externalTransactionId: string;
  providerId?: string;
  roundId?: string;
  referenceExternalTransactionId?: string;
  idempotencyKey?: string;
}

export function submit(base: string, input: SubmitInput) {
  const providerId = input.providerId ?? 'provider-a';
  return http<{
    transactionId: string;
    status: string;
    balance: { amount: string } | null;
    idempotentReplay: boolean;
    failureCode?: string;
  }>(
    base,
    'POST',
    '/wagering/transactions',
    {
      providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind: input.kind,
      money: { amount: input.amount, currency: 'BRL' },
      ...(input.referenceExternalTransactionId
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
    },
    { 'idempotency-key': input.idempotencyKey ?? `${providerId}:${input.externalTransactionId}` },
  );
}

export async function createWallet(base: string, playerId: string, amount: string) {
  const res = await http<{ id: string; version: number; balance: { amount: string } }>(
    base,
    'POST',
    '/wallets',
    {
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    },
  );
  if (res.status !== 201)
    throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
