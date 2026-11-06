import type { Clock, IdGenerator } from '../application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: ordenado no tempo (boa localidade nos índices btree), em minúsculas. */
export class UuidV7Generator implements IdGenerator {
  newId(): string {
    return Bun.randomUUIDv7();
  }
}
