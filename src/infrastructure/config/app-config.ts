import { z } from 'zod';

export const ROLES = ['api', 'consumer', 'outbox', 'pending-ref', 'all'] as const;
export type Role = (typeof ROLES)[number];

const schema = z
  .object({
    ROLE: z.enum(ROLES).default('all'),
    // 0 = porta efêmera escolhida pelo SO (o log de inicialização informa a porta real)
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL deve começar com postgres://'),
    DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    DB_APPLICATION_NAME: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,63}$/, 'use até 63 caracteres [A-Za-z0-9._-]')
      .optional(),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    AWS_ACCESS_KEY_ID: z.string().min(1),
    AWS_SECRET_ACCESS_KEY: z.string().min(1),
    SQS_ENDPOINT: z.string().url().optional(),
    SQS_WAGER_QUEUE_NAME: z.string().min(1).default('wager-transactions.fifo'),
    SQS_WAGER_DLQ_NAME: z.string().min(1).default('wager-transactions-dlq.fifo'),
    SQS_EVENTS_QUEUE_NAME: z.string().min(1).default('wagering-events'),
    // consumer de wager-transactions.fifo (ARCHITECTURE §9 e §18)
    SQS_CONSUMER_NAME: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'use até 128 caracteres [A-Za-z0-9._:-]')
      .default('wager-transactions-consumer'),
    // o shutdown espera o long poll em andamento: fica abaixo de SQS_SHUTDOWN_TIMEOUT_MS
    SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
    SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
    SQS_VISIBILITY_TIMEOUT_S: z.coerce.number().int().min(1).max(43_200).default(30),
    SQS_RETRY_BASE_DELAY_S: z.coerce.number().int().min(0).max(43_200).default(2),
    SQS_RETRY_MAX_DELAY_S: z.coerce.number().int().min(0).max(43_200).default(60),
    SQS_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
  })
  .refine((e) => e.SQS_RETRY_MAX_DELAY_S >= e.SQS_RETRY_BASE_DELAY_S, {
    path: ['SQS_RETRY_MAX_DELAY_S'],
    message: 'deve ser maior ou igual a SQS_RETRY_BASE_DELAY_S',
  });

export interface AppConfig {
  role: Role;
  port: number;
  logLevel: string;
  databaseUrl: string;
  /** Espera máxima por um lock de linha (ex.: wallet disputada) antes de falhar como transitório. */
  dbLockTimeoutMs: number;
  /** Máximo de conexões do pool deste processo. */
  dbPoolMax: number;
  /** `application_name` das conexões: identifica o processo no `pg_stat_activity` (quem trava o quê). */
  dbApplicationName: string;
  aws: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sqsEndpoint: string | undefined;
  };
  queues: { wager: string; wagerDlq: string; events: string };
  consumer: ConsumerConfig;
}

export interface ConsumerConfig {
  /** Nome lógico gravado na inbox: o mesmo em todas as instâncias. */
  name: string;
  /** Long polling do ReceiveMessage (0–20s). */
  waitTimeSeconds: number;
  maxMessages: number;
  /** Visibilidade de cada recebimento: maior que lock_timeout + processamento. */
  visibilityTimeoutS: number;
  /** Backoff de erro transitório: min(base × 2^(tentativa−1), máximo), em segundos. */
  retryBaseDelayS: number;
  retryMaxDelayS: number;
  /** Prazo para terminar as mensagens em andamento no SIGTERM. */
  shutdownTimeoutMs: number;
}

export class ConfigError extends Error {}

/** Valida o ambiente e falha cedo, listando todas as variáveis inválidas. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Configuração inválida:\n${issues}`);
  }
  const e = result.data;
  return {
    role: e.ROLE,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    dbLockTimeoutMs: e.DB_LOCK_TIMEOUT_MS,
    dbPoolMax: e.DB_POOL_MAX,
    dbApplicationName: e.DB_APPLICATION_NAME ?? `wagering-${e.ROLE}`,
    aws: {
      region: e.AWS_REGION,
      accessKeyId: e.AWS_ACCESS_KEY_ID,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
      sqsEndpoint: e.SQS_ENDPOINT,
    },
    queues: {
      wager: e.SQS_WAGER_QUEUE_NAME,
      wagerDlq: e.SQS_WAGER_DLQ_NAME,
      events: e.SQS_EVENTS_QUEUE_NAME,
    },
    consumer: {
      name: e.SQS_CONSUMER_NAME,
      waitTimeSeconds: e.SQS_WAIT_TIME_SECONDS,
      maxMessages: e.SQS_MAX_MESSAGES,
      visibilityTimeoutS: e.SQS_VISIBILITY_TIMEOUT_S,
      retryBaseDelayS: e.SQS_RETRY_BASE_DELAY_S,
      retryMaxDelayS: e.SQS_RETRY_MAX_DELAY_S,
      shutdownTimeoutMs: e.SQS_SHUTDOWN_TIMEOUT_MS,
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
