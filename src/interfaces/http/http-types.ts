/**
 * Tipos mínimos de request/response do Express usados pela borda HTTP (o projeto não depende de
 * `@types/express`).
 */
export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
  readonly headersSent: boolean;
}
