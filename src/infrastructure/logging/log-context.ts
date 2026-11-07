import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Campos de correlação de uma unidade de trabalho (requisição HTTP, mensagem SQS): `correlationId`,
 * `messageId`, `transactionId`, `walletId`, `providerId`… Só identificadores e códigos: nunca valores
 * em dinheiro nem o payload.
 */
export type LogContext = Record<string, string | number | boolean>;

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Roda `fn` com `context` como contexto de log: todo log emitido dentro dele (inclusive em código
 * assíncrono chamado por ele) sai com esses campos, pelo `mixin` do logger. O próprio objeto vira o
 * contexto (quem o criou vê o que `addLogContext` acrescentar) e herda os campos do contexto de fora
 * que ele não define.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = storage.getStore();
  if (parent) {
    for (const [key, value] of Object.entries(parent)) {
      if (!(key in context)) {
        context[key] = value;
      }
    }
  }
  return storage.run(context, fn);
}

/** Acrescenta campos ao contexto atual (ex.: o `transactionId` depois do processamento). */
export function addLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) {
    Object.assign(store, fields);
  }
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
