import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { ensureTestDatabase, testDatabaseUrl } from './database';
import { type HttpTarget, httpRequest, type RequestOptions, type TestResponse } from './http-app';

/**
 * Instâncias reais da aplicação, cada uma num processo próprio (`bun src/main.ts`, papel `api`),
 * contra o banco `wagering_test`. Cada processo tem o seu grafo Nest, o seu pool de conexões e o
 * seu gerador de ids: o único estado compartilhado é o Postgres, como em produção.
 *
 * - Porta efêmera (`PORT=0`): a instância só é considerada pronta quando o log
 *   `application started` informa a porta real (sem sleeps).
 * - `application_name` próprio (`<cluster>-<n>-g<geração>`): o `pg_stat_activity` mostra de qual
 *   processo vem cada conexão, o que permite provar quantas instâncias esperavam um lock.
 * - stdout/stderr drenados o tempo todo (pipe cheio trava o filho); as últimas linhas entram na
 *   mensagem de erro se a instância cair ou não subir.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..');
const STARTUP_TIMEOUT_MS = 30_000;
const LOG_TAIL = 60;

/** Ambiente padrão das instâncias nos testes de concorrência. */
export const CLUSTER_ENV: Readonly<Record<string, string>> = {
  ROLE: 'api',
  LOG_LEVEL: 'info',
  // 50 requisições presas ao mesmo tempo no lock da wallet precisam de conexões abertas
  DB_POOL_MAX: '20',
  // a barreira do teste segura o lock enquanto as requisições chegam; 20s evita um 503 numa
  // máquina lenta (o 503 por lock_timeout é coberto nos testes de integração)
  DB_LOCK_TIMEOUT_MS: '20000',
};

/** Processos vivos, para não deixar órfãos se o runner encerrar no meio. */
const liveProcesses = new Set<Subprocess>();
process.on('exit', () => {
  for (const proc of liveProcesses) {
    proc.kill('SIGKILL');
  }
});

export class AppInstance implements HttpTarget {
  private constructor(
    readonly applicationName: string,
    readonly baseUrl: string,
    readonly pid: number,
    private readonly proc: Subprocess,
    private readonly logs: string[],
  ) {}

  static async start(
    applicationName: string,
    env: Readonly<Record<string, string>> = {},
  ): Promise<AppInstance> {
    await ensureTestDatabase();
    const proc = Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...CLUSTER_ENV,
        DATABASE_URL: testDatabaseUrl(),
        ...env,
        PORT: '0',
        DB_APPLICATION_NAME: applicationName,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    liveProcesses.add(proc);
    void proc.exited.then(() => liveProcesses.delete(proc));

    const logs: string[] = [];
    let onStarted!: (port: number) => void;
    const started = new Promise<number>((resolve) => {
      onStarted = resolve;
    });
    const onLine = (line: string): void => {
      logs.push(line);
      if (logs.length > LOG_TAIL) {
        logs.shift();
      }
      const port = startedPort(line);
      if (port !== undefined) {
        onStarted(port);
      }
    };
    void drainLines(proc.stdout, onLine);
    void drainLines(proc.stderr, onLine);

    let timer: Timer | undefined;
    const outcome = await Promise.race([
      started.then((port) => ({ port })),
      proc.exited.then((code) => ({ exitCode: code })),
      new Promise<{ timeout: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), STARTUP_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!('port' in outcome)) {
      proc.kill('SIGKILL');
      const reason =
        'exitCode' in outcome
          ? `encerrou com código ${outcome.exitCode}`
          : `não subiu em ${STARTUP_TIMEOUT_MS}ms`;
      throw new Error(`instância ${applicationName} ${reason}:\n${logs.join('\n')}`);
    }
    return new AppInstance(
      applicationName,
      // 127.0.0.1 e não localhost: o servidor escuta em IPv4 e o Windows tenta ::1 primeiro
      `http://127.0.0.1:${outcome.port}`,
      proc.pid,
      proc,
      logs,
    );
  }

  get alive(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  request(method: string, path: string, options?: RequestOptions): Promise<TestResponse> {
    return httpRequest(this.baseUrl, method, path, options);
  }

  /** Mata o processo sem aviso (SIGKILL; TerminateProcess no Windows), como uma queda real. */
  async kill(): Promise<void> {
    if (this.alive) {
      this.proc.kill('SIGKILL');
    }
    await this.proc.exited;
  }

  recentLogs(): string {
    return this.logs.join('\n');
  }
}

export class Cluster {
  private generation = 1;

  private constructor(
    /** Prefixo dos `application_name` de todas as instâncias deste cluster. */
    readonly id: string,
    private readonly members: AppInstance[],
    private readonly env: Readonly<Record<string, string>>,
  ) {}

  static async start({
    size = 3,
    env = {},
  }: {
    size?: number;
    env?: Record<string, string>;
  } = {}): Promise<Cluster> {
    const id = `cc${randomBytes(4).toString('hex')}`;
    const members = await Promise.all(
      Array.from({ length: size }, (_, index) => AppInstance.start(memberName(id, index, 1), env)),
    );
    return new Cluster(id, members, env);
  }

  get size(): number {
    return this.members.length;
  }

  get instances(): readonly AppInstance[] {
    return this.members;
  }

  instance(index: number): AppInstance {
    const member = this.members[index];
    if (!member) {
      throw new Error(`o cluster não tem a instância ${index}`);
    }
    return member;
  }

  /** Distribuição round-robin: a requisição `i` vai para a instância `i % size`. */
  pick(i: number): AppInstance {
    return this.instance(i % this.members.length);
  }

  /** Mata a instância (se viva) e sobe outra no lugar, com outra porta e outro `application_name`. */
  async restart(index: number): Promise<AppInstance> {
    await this.instance(index).kill();
    this.generation += 1;
    const next = await AppInstance.start(memberName(this.id, index, this.generation), this.env);
    this.members[index] = next;
    return next;
  }

  /** Mata todas e sobe uma geração nova inteira (reinício completo do serviço). */
  async restartAll(): Promise<void> {
    await Promise.all(this.members.map((member) => member.kill()));
    this.generation += 1;
    const next = await Promise.all(
      this.members.map((_, index) =>
        AppInstance.start(memberName(this.id, index, this.generation), this.env),
      ),
    );
    this.members.splice(0, this.members.length, ...next);
  }

  async stop(): Promise<void> {
    await Promise.all(this.members.map((member) => member.kill()));
  }
}

const memberName = (clusterId: string, index: number, generation: number): string =>
  `${clusterId}-${index}-g${generation}`;

/** Porta real do log JSON `application started` (pino), se for essa a linha. */
function startedPort(line: string): number | undefined {
  if (!line.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as { msg?: unknown; port?: unknown };
    return parsed.msg === 'application started' && typeof parsed.port === 'number'
      ? parsed.port
      : undefined;
  } catch {
    return undefined;
  }
}

async function drainLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        onLine(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
      }
    }
  } catch {
    // processo morto: o stream fecha com erro
  }
  if (buffer) {
    onLine(buffer);
  }
}
