import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors';

/** DTO: valores trafegam como string decimal, nunca como number. */
export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

// Clone isolado: não depende da configuração global do decimal.js e tem precisão de sobra.
const Dec = Decimal.clone({ precision: 40 });
type Dec = InstanceType<typeof Dec>;

const SCALE = 2;
/** Entrada: sem sinal, sem notação científica, no máximo 2 casas. */
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** Limite de numeric(20,2): 18 dígitos inteiros + 2 decimais. */
const MAX_ABS = new Dec('999999999999999999.99');

export class Money {
  private constructor(
    private readonly value: Dec,
    public readonly currency: string,
  ) {}

  /**
   * Parse estrito de contrato de entrada: string não negativa com até 2 casas.
   * Nunca arredonda: "10.005" é rejeitado.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money deve ser um objeto { amount, currency }');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal (ex.: "25.00")');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount inválido: esperado decimal não negativo com até ${SCALE} casas, recebido "${amount}"`,
      );
    }
    Money.assertCurrency(currency);
    return Money.build(new Dec(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return Money.build(new Dec(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.build(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.build(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.build(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Moedas diferentes nunca são iguais (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        `currency inválida: esperado 3 letras maiúsculas (ISO-4217), recebido "${String(currency)}"`,
      );
    }
  }

  /** Fixa a escala 2 e garante que o valor cabe em numeric(20,2). */
  private static build(raw: Dec, currency: string): Money {
    // toDecimalPlaces só normaliza a escala: toda entrada/operação já tem no máximo 2 casas.
    const value = raw.isZero() ? new Dec(0) : raw.toDecimalPlaces(SCALE);
    if (value.abs().greaterThan(MAX_ABS)) {
      throw new InvalidMoneyError('Valor excede o limite de numeric(20,2)');
    }
    return new Money(value, currency);
  }
}
