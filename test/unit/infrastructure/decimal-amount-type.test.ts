import { describe, expect, test } from 'bun:test';
import { DecimalAmountType } from '../../../src/infrastructure/database/types/decimal-amount.type';

const type = new DecimalAmountType();
const toDb = (value: unknown) => type.convertToDatabaseValue(value as string);
const toJs = (value: unknown) => type.convertToJSValue(value as string);

describe('DecimalAmountType (numeric(20,2) <-> string)', () => {
  test('mapeia para numeric(20,2)', () => {
    expect(type.getColumnType()).toBe('numeric(20,2)');
    expect(type.compareAsType()).toBe('string');
  });

  test('passa strings canônicas nos dois sentidos, sem conversão', () => {
    for (const value of ['0.00', '25.00', '999999999999999999.99', '-5.00']) {
      expect(toDb(value)).toBe(value);
      expect(toJs(value)).toBe(value);
    }
  });

  test('recusa number nos dois sentidos', () => {
    expect(() => toDb(25)).toThrow(TypeError);
    expect(() => toJs(25)).toThrow(TypeError);
    expect(() => toDb(25n)).toThrow(TypeError);
  });

  test('recusa formatos que o Postgres arredondaria ou que não cabem em numeric(20,2)', () => {
    for (const value of [
      '10.005',
      '10',
      '10.5',
      '1e3',
      '',
      'NaN',
      'Infinity',
      '1000000000000000000.00',
    ]) {
      expect(() => toDb(value)).toThrow(TypeError);
    }
  });

  test('null/undefined passam (colunas nullable)', () => {
    expect(toDb(null)).toBeNull();
    expect(toJs(undefined)).toBeUndefined();
  });
});
