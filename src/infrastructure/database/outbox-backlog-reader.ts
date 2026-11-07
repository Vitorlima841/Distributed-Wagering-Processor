import type { MikroORM } from '@mikro-orm/postgresql';

export interface OutboxBacklog {
  /** Eventos ainda não publicados. */
  pending: number;
  /** Idade do evento não publicado mais antigo, em segundos (0 se não houver). */
  oldestAgeSeconds: number;
}

/**
 * Backlog da outbox para os gauges lidos no scrape. Varre só o índice parcial `ix_outbox_due`
 * (`where published_at is null`). A idade usa o relógio do banco.
 */
export class OutboxBacklogReader {
  constructor(private readonly orm: MikroORM) {}

  async read(): Promise<OutboxBacklog> {
    const [row] = await this.orm.em.fork().execute<{ pending: number; oldest: number | null }[]>(
      `select count(*)::int as pending,
              extract(epoch from (now() - min(occurred_at)))::float8 as oldest
         from outbox_messages
        where published_at is null`,
    );
    return {
      pending: row?.pending ?? 0,
      oldestAgeSeconds: Math.max(row?.oldest ?? 0, 0),
    };
  }
}
