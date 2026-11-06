/** Códigos estáveis e legíveis por máquina. Taxonomia documentada em ARCHITECTURE.md §7. */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed = 'ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  InfraPermanentError = 'INFRA_PERMANENT_ERROR',
}

/** O que o provedor deve fazer ao receber o código. */
export type ProviderAction = 'give_up' | 'fix_payload' | 'investigate' | 'contact_support';

export const FAILURE_CODE_GUIDANCE: Readonly<Record<FailureCode, ProviderAction>> = {
  [FailureCode.InsufficientFunds]: 'give_up',
  [FailureCode.ReversalInsufficientFunds]: 'investigate',
  [FailureCode.ReferenceNotFound]: 'fix_payload',
  [FailureCode.ReferenceMismatch]: 'fix_payload',
  [FailureCode.ReferenceInvalidKind]: 'fix_payload',
  [FailureCode.ReferenceNotProcessed]: 'give_up',
  [FailureCode.AlreadyReversed]: 'give_up',
  [FailureCode.AmountMismatch]: 'fix_payload',
  [FailureCode.CurrencyMismatch]: 'fix_payload',
  [FailureCode.WalletPlayerMismatch]: 'fix_payload',
  [FailureCode.InfraPermanentError]: 'contact_support',
};

/** Códigos aceitos em `reject()` (status REJECTED). `fail()` aceita só INFRA_PERMANENT_ERROR. */
export const BUSINESS_FAILURE_CODES: readonly FailureCode[] = Object.values(FailureCode).filter(
  (code) => code !== FailureCode.InfraPermanentError,
);

export function isBusinessFailureCode(code: FailureCode): boolean {
  return BUSINESS_FAILURE_CODES.includes(code);
}
