/**
 * Tipos mínimos de request/response do Express usados pela borda HTTP (o projeto não depende de
 * `@types/express`).
 */
export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  /** Rota do Express que atendeu (modelo, ex. `/wallets/:walletId`); ausente se nenhuma bateu. */
  route?: { path?: unknown };
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
  send(body: string): unknown;
  on(event: 'finish', listener: () => void): unknown;
  readonly headersSent: boolean;
  readonly statusCode: number;
}
