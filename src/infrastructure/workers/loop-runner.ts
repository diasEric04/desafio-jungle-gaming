import type { Logger } from '@/application/ports/services';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Runs `tick` repeatedly. A tick that reports it did a full batch of work is followed immediately by
 * another one (draining a backlog); otherwise the loop sleeps `intervalMs`. `stop()` interrupts the
 * sleep and waits for the tick in flight, so shutdown never abandons a half-finished batch.
 */
export class LoopRunner {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: Logger,
    private readonly onError?: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = this.loop();
  }

  async stop(timeoutMs: number): Promise<void> {
    this.abort.abort();
    if (!this.running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn('worker did not stop in time', { worker: this.name, timeoutMs });
        resolve();
      }, timeoutMs);
    });
    await Promise.race([this.running, timeout]);
    clearTimeout(timer);
  }

  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      let more = false;
      try {
        more = await this.tick();
      } catch (error) {
        this.onError?.(error);
        this.logger.error('worker tick failed', {
          worker: this.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!more) await sleep(this.intervalMs, this.abort.signal);
    }
  }
}
