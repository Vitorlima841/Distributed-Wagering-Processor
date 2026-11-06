import { Money } from '../../../src/domain/money/money';

/** Builders de teste: dinheiro sempre como string decimal, nunca number. */
export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

export const T0 = new Date('2026-07-29T15:00:00.000Z');
export const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

let seq = 0;
/** Ids determinísticos para os testes. */
export const nextId = (prefix = 'id'): string => `${prefix}-${++seq}`;
