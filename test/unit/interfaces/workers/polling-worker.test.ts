import { describe, expect, test } from 'bun:test';
import pino from 'pino';
import { type CycleResult, PollingWorker } from '../../../../src/interfaces/workers/polling-worker';

const silent = pino({ level: 'silent' });

describe('PollingWorker', () => {
  test('lote cheio roda o próximo ciclo na hora; vazio espera o intervalo', async () => {
    const results: CycleResult[] = [{ busy: true }, { busy: true }, { busy: false }];
    const startedAt: number[] = [];
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new PollingWorker(
      'test',
      async () => {
        startedAt.push(performance.now());
        if (startedAt.length === 4) {
          release();
        }
        return results.shift() ?? { busy: false };
      },
      silent,
      { pollIntervalMs: 200 },
    );
    worker.start();
    await done;
    await worker.stop();
    const gaps = startedAt.slice(1).map((t, i) => t - (startedAt[i] as number));
    expect(gaps[0]).toBeLessThan(100);
    expect(gaps[1]).toBeLessThan(100);
    expect(gaps[2]).toBeGreaterThanOrEqual(150);
  });

  test('ciclo que falha não mata o loop: pausa e tenta de novo', async () => {
    let calls = 0;
    let recovered!: () => void;
    const done = new Promise<void>((resolve) => {
      recovered = resolve;
    });
    const worker = new PollingWorker(
      'test',
      async () => {
        calls += 1;
        if (calls <= 2) {
          throw new Error('banco fora do ar');
        }
        recovered();
        return { busy: false };
      },
      silent,
      { pollIntervalMs: 1_000, failureBackoff: { initialMs: 5, maxMs: 10 } },
    );
    worker.start();
    await done;
    await worker.stop();
    expect(calls).toBe(3);
  });

  test('stop() interrompe a espera e aguarda o ciclo em andamento', async () => {
    let finishCycle!: () => void;
    let cycleStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      cycleStarted = resolve;
    });
    let finished = false;
    const worker = new PollingWorker(
      'test',
      async () => {
        cycleStarted();
        await new Promise<void>((resolve) => {
          finishCycle = resolve;
        });
        finished = true;
        return { busy: false };
      },
      silent,
      { pollIntervalMs: 60_000 },
    );
    worker.start();
    await started;
    const stopping = worker.stop();
    expect(worker.isRunning).toBe(false);
    finishCycle();
    await stopping;
    expect(finished).toBe(true);
  });
});
