import { Type } from '@mikro-orm/core';

/** Formato de `numeric(20,2)`: até 18 dígitos inteiros e exatamente 2 casas. */
const NUMERIC_20_2 = /^-?\d{1,18}\.\d{2}$/;

/**
 * `numeric(20,2)` ↔ string decimal canônica ("25.00"). O valor nunca passa por `number`:
 * o driver `pg` já devolve `numeric` como string, e este tipo recusa qualquer outra coisa nos
 * dois sentidos. Também recusa mais de 2 casas, para o Postgres não arredondar em silêncio.
 *
 * Um tipo do MikroORM enxerga uma coluna só; o `Money` (valor + moeda) é montado no mapper.
 */
export class DecimalAmountType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    return DecimalAmountType.assertAmount(value, 'gravar');
  }

  override convertToJSValue(value: string): string {
    return DecimalAmountType.assertAmount(value, 'ler');
  }

  override getColumnType(): string {
    return 'numeric(20,2)';
  }

  override compareAsType(): string {
    return 'string';
  }

  override ensureComparable(): boolean {
    return false;
  }

  private static assertAmount(value: unknown, direction: 'gravar' | 'ler'): string {
    // colunas nullable: o MikroORM pode repassar null/undefined
    if (value === null || value === undefined) {
      return value as unknown as string;
    }
    if (typeof value !== 'string') {
      throw new TypeError(
        `DecimalAmountType: tentativa de ${direction} ${typeof value} como numeric(20,2); dinheiro trafega só como string`,
      );
    }
    if (!NUMERIC_20_2.test(value)) {
      throw new TypeError(
        `DecimalAmountType: "${value}" não está no formato de numeric(20,2) (ex.: "25.00")`,
      );
    }
    return value;
  }
}
