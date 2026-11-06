/** Relógio da aplicação: o domínio nunca chama `new Date()` (ARCHITECTURE §14.5). */
export interface Clock {
  now(): Date;
}

/** Gera identificadores únicos (UUID em minúsculas) para transações, lançamentos e eventos. */
export interface IdGenerator {
  newId(): string;
}

export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
