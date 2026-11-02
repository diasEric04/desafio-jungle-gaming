import { describe, expect, test } from 'bun:test';
import { silentLogger } from '../support/in-memory';
import { LoopRunner } from '@/infrastructure/workers/loop-runner';

describe('LoopRunner', () => {
  test('drains while ticks report more work, sleeps otherwise, and stops promptly', async () => {
    let calls = 0;
    const runner = new LoopRunner(
      't',
      10_000,
      async () => {
        calls += 1;
        return calls < 5; // 4 full batches, then idle -> sleeps 10s
      },
      silentLogger,
    );
    runner.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(5);
    const started = Date.now();
    await runner.stop(1_000); // interrupts the 10s sleep
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('a failing tick is reported and does not kill the loop', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const runner = new LoopRunner(
      't',
      5,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('db down');
        return false;
      },
      silentLogger,
      (e) => errors.push(e),
    );
    runner.start();
    await new Promise((r) => setTimeout(r, 60));
    await runner.stop(500);
    expect(errors).toHaveLength(1);
    expect(calls).toBeGreaterThan(1);
  });

  test('stop waits for the tick in flight', async () => {
    let finished = false;
    const runner = new LoopRunner(
      't',
      1_000,
      async () => {
        await new Promise((r) => setTimeout(r, 80));
        finished = true;
        return false;
      },
      silentLogger,
    );
    runner.start();
    await new Promise((r) => setTimeout(r, 10));
    await runner.stop(1_000);
    expect(finished).toBe(true);
  });
});
