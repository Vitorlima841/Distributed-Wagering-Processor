import type { Clock } from '../../src/application/ports';

/** Relógio controlado pelo teste: o backoff é exercitado sem sleeps. */
export class ManualClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date()) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }

  set(at: Date): void {
    this.current = new Date(at.getTime());
  }
}
