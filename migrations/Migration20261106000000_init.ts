import { Migration } from '@mikro-orm/migrations';

/** Migration inicial: só prova o fluxo up/down. As tabelas chegam na fase 3. */
export class Migration20261106000000Init extends Migration {
  override async up(): Promise<void> {
    this.addSql('create extension if not exists "pgcrypto";');
  }

  override async down(): Promise<void> {
    this.addSql('drop extension if exists "pgcrypto";');
  }
}
