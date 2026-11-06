import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
  test.each([
    ['0', '0.00'],
    ['0.0', '0.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.00', '25.00'],
    ['007.50', '7.50'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('normaliza "%s" para escala 2 ("%s")', (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '-1.00',
    '+1.00',
    '1.234',
    '10.005',
    '.5',
    '5.',
    '1,00',
    '0x10',
    ' 1.00',
    '1.00 ',
    '1 .00',
    '1000000000000000000.00', // 19 dígitos inteiros: estoura numeric(20,2)
  ])('rejeita entrada inválida "%s" (nunca arredonda)', (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (JSON com número)', () => {
    const parsed = JSON.parse('{"amount":25.5,"currency":"BRL"}');
    expect(() => Money.from(parsed)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount ausente', () => {
    expect(() => Money.from({ currency: 'BRL' } as never)).toThrow(InvalidMoneyError);
  });

  test.each(['', 'br', 'BRLL', 'brl', 'B1L', 'R$'])('rejeita moeda inválida "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money.zero', () => {
  test('cria zero na moeda informada', () => {
    const zero = Money.zero('BRL');
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(zero.isZero()).toBe(true);
  });

  test('valida a moeda', () => {
    expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
  });
});

describe('Money operações', () => {
  test('soma sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30 BRL');
  });

  test('subtrai', () => {
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
  });

  test('subtração pode resultar em negativo e serializa com sinal', () => {
    const result = brl('10.00').subtract(brl('25.50'));
    expect(result.isNegative()).toBe(true);
    expect(result.isPositive()).toBe(false);
    expect(result.toJSON().amount).toBe('-15.50');
  });

  test('negate inverte o sinal e negate(0) continua zero', () => {
    expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    expect(Money.zero('BRL').negate().isNegative()).toBe(false);
  });

  test('é imutável: operações devolvem nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b).not.toBe(a);
  });

  test('predicados', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isZero()).toBe(false);
  });

  test('isLessThan e equals', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80').equals(brl('80.00'))).toBe(true);
    expect(brl('80.00').equals(brl('80.01'))).toBe(false);
  });

  test('estouro do limite numeric(20,2) é erro, não arredondamento silencioso', () => {
    const max = brl('999999999999999999.99');
    expect(() => max.add(brl('0.01'))).toThrow(InvalidMoneyError);
  });

  test('toJSON é estável e vai para JSON.stringify como string', () => {
    expect(JSON.stringify({ money: brl('25') })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });
});

describe('Money conflito de moeda', () => {
  test('add, subtract e isLessThan lançam CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd('2.00'))).toThrow(CurrencyMismatchError);
  });

  test('equals entre moedas diferentes é false (não lança)', () => {
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });
});
