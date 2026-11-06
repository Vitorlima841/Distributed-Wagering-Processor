import type { Server } from 'bun';
import { sqsEndpoint } from './sqs';

/**
 * Proxy HTTP na frente do LocalStack. O consumer (em processo ou num processo filho) aponta o
 * `SQS_ENDPOINT` para cá: as chamadas seguem para o SQS real, e o teste vê cada uma (operação,
 * corpo, instante, mensagens devolvidas) e pode segurar uma operação sem responder. É assim que o
 * teste prova "ack só depois do COMMIT" e mata o processo entre os dois, sem gancho de teste no
 * código de produção.
 *
 * O SDK usa o protocolo JSON da AWS: a operação vem no header `X-Amz-Target` (`AmazonSQS.<Op>`).
 */

export interface ProxiedCall {
  operation: string;
  // biome-ignore lint/suspicious/noExplicitAny: corpo JSON livre da API do SQS
  input: any;
  at: number;
  /** A chamada recebeu um erro injetado por `fail()` (não chegou ao SQS). */
  failed?: boolean;
  /** Só ReceiveMessage: o que o SQS devolveu (id do envelope, handle e contagem de recebimentos). */
  received?: { messageId: string | undefined; receiptHandle: string; receiveCount: number }[];
}

interface Hold {
  operation: string;
  arrived: (call: ProxiedCall) => void;
  released: Promise<void>;
}

export interface HeldCall {
  /** Resolve quando a primeira chamada da operação chega (e fica parada). */
  arrived: Promise<ProxiedCall>;
  /** Encaminha a chamada parada ao SQS. */
  release(): void;
}

export class SqsProxy {
  readonly calls: ProxiedCall[] = [];
  private holds: Hold[] = [];
  private responseHolds: Hold[] = [];
  private readonly failing = new Set<string>();

  private constructor(
    private readonly server: Server<undefined>,
    private readonly upstream: string,
  ) {}

  static start(upstream = sqsEndpoint()): SqsProxy {
    let proxy: SqsProxy | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 60,
      fetch: (request) => {
        if (!proxy) {
          return new Response('proxy não iniciado', { status: 503 });
        }
        return proxy.forward(request);
      },
    });
    proxy = new SqsProxy(server, upstream.replace(/\/$/, ''));
    return proxy;
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Chamadas de uma operação (ex.: `DeleteMessage`), na ordem em que chegaram. */
  of(operation: string): ProxiedCall[] {
    return this.calls.filter((call) => call.operation === operation);
  }

  /** Segura a próxima chamada da operação (só a próxima) até `release()`. */
  hold(operation: string): HeldCall {
    let arrived!: (call: ProxiedCall) => void;
    let release!: () => void;
    const arrivedPromise = new Promise<ProxiedCall>((resolve) => {
      arrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.push({ operation, arrived, released });
    return { arrived: arrivedPromise, release };
  }

  /**
   * Encaminha a próxima chamada da operação ao SQS, mas segura a **resposta** até `release()`:
   * o efeito já aconteceu no SQS e o cliente ainda não sabe (o caso "publicou e morreu antes do
   * COMMIT"). `arrived` resolve depois que o SQS respondeu.
   */
  holdResponse(operation: string): HeldCall {
    let arrived!: (call: ProxiedCall) => void;
    let release!: () => void;
    const arrivedPromise = new Promise<ProxiedCall>((resolve) => {
      arrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.responseHolds.push({ operation, arrived, released });
    return { arrived: arrivedPromise, release };
  }

  /**
   * Responde erro (400, não repetido pelo SDK) a toda chamada da operação, sem encaminhar ao SQS,
   * até `restore()`. Simula o SQS recusando ou fora do ar.
   */
  fail(operation: string): { restore(): void } {
    this.failing.add(operation);
    return { restore: () => this.failing.delete(operation) };
  }

  /** Fecha o servidor e derruba conexões abertas (inclusive chamadas seguradas). */
  stop(): void {
    this.server.stop(true);
  }

  private async forward(request: Request): Promise<Response> {
    const target = request.headers.get('x-amz-target') ?? '';
    const operation = target.replace(/^AmazonSQS\./, '');
    const body = await request.text();
    const call: ProxiedCall = { operation, input: parseJson(body), at: performance.now() };
    this.calls.push(call);

    if (this.failing.has(operation)) {
      call.failed = true;
      return new Response(
        JSON.stringify({ __type: 'com.amazonaws.sqs#InjectedFailure', message: 'injected' }),
        {
          status: 400,
          headers: {
            'content-type': 'application/x-amz-json-1.0',
            'x-amzn-query-error': 'InjectedFailure;Sender',
          },
        },
      );
    }

    const hold = this.holds.find((candidate) => candidate.operation === operation);
    if (hold) {
      this.holds = this.holds.filter((candidate) => candidate !== hold);
      hold.arrived(call);
      await hold.released;
    }

    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    const upstream = await fetch(`${this.upstream}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
    });
    const text = await upstream.text();
    if (operation === 'ReceiveMessage') {
      call.received = receivedMessages(text);
    }
    const responseHeaders = new Headers(upstream.headers);
    // o fetch já descomprimiu o corpo; os tamanhos e a codificação originais não valem mais
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    const responseHold = this.responseHolds.find((candidate) => candidate.operation === operation);
    if (responseHold) {
      this.responseHolds = this.responseHolds.filter((candidate) => candidate !== responseHold);
      responseHold.arrived(call);
      await responseHold.released;
    }
    return new Response(text, { status: upstream.status, headers: responseHeaders });
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function receivedMessages(text: string): ProxiedCall['received'] {
  const parsed = parseJson(text) as {
    Messages?: { Body?: string; ReceiptHandle?: string; Attributes?: Record<string, string> }[];
  };
  return (parsed.Messages ?? []).map((message) => {
    const envelope = parseJson(message.Body ?? '') as { messageId?: unknown };
    return {
      messageId: typeof envelope?.messageId === 'string' ? envelope.messageId : undefined,
      receiptHandle: message.ReceiptHandle ?? '',
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 0),
    };
  });
}
