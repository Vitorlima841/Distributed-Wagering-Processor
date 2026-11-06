import { z } from 'zod';

export const ROLES = ['api', 'consumer', 'outbox', 'pending-ref', 'all'] as const;
export type Role = (typeof ROLES)[number];

const schema = z.object({
  ROLE: z.enum(ROLES).default('all'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL deve começar com postgres://'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_ENDPOINT: z.string().url().optional(),
  SQS_WAGER_QUEUE_NAME: z.string().min(1).default('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: z.string().min(1).default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().min(1).default('wagering-events'),
});

export interface AppConfig {
  role: Role;
  port: number;
  logLevel: string;
  databaseUrl: string;
  aws: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sqsEndpoint: string | undefined;
  };
  queues: { wager: string; wagerDlq: string; events: string };
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
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
