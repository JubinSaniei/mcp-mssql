import { z } from 'zod';

/** Largest delay Node timers accept; longer millisecond values would fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;

/** Log levels pino accepts without custom levels. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  user: string;
  password: string;
  server: string;
  database: string;
  port: number;
  connectionTimeout: number;
  requestTimeout: number;
  pool: {
    max: number;
    min: number;
    idleTimeoutMillis: number;
  };
  options: {
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
  maxRetries: number;
  initialRetryDelay: number;
  maxRetryDelay: number;
  schemaCacheTTL: number;
  maxRows: number;
  allowedDatabases: string[];
  /** Stored procedures execute_stored_procedure may run, as schema.proc; parsed and validated by DatabaseService. */
  allowedProcedures: string[];
  logLevel: LogLevel;
}

/** A string variable; unset or empty falls back to `fallback`. */
const text = (fallback: string) => z.string().optional().transform((value) => value || fallback);

/** A whole-number variable in [min, max]; unset or empty falls back to `fallback`. */
const wholeNumber = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value ? value.trim() : String(fallback)))
    .pipe(
      z
        .string()
        .regex(/^-?\d+$/, 'must be a whole number')
        .transform(Number)
        .pipe(z.number().int().min(min).max(max))
    );

/** A whole-number variable with no fixed default; unset or empty stays undefined. */
const optionalWholeNumber = (min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value ? value.trim() : undefined))
    .pipe(
      z
        .string()
        .regex(/^-?\d+$/, 'must be a whole number')
        .transform(Number)
        .pipe(z.number().int().min(min).max(max))
        .optional()
    );

/** A comma-separated list; entries are trimmed and empty entries dropped. */
const list = () =>
  z
    .string()
    .optional()
    .transform((value) => (value || '').split(',').map((entry) => entry.trim()).filter(Boolean));

const envSchema = z
  .object({
    SQL_USER: text('sa'),
    SQL_PASSWORD: text('yourStrong(!)Password'),
    SQL_SERVER: text('localhost'),
    SQL_DATABASE: text('master'),
    SQL_PORT: wholeNumber(1433, 1, 65535),
    SQL_CONNECTION_TIMEOUT: wholeNumber(15000, 0, MAX_TIMER_MS),
    SQL_REQUEST_TIMEOUT: wholeNumber(15000, 0, MAX_TIMER_MS),
    SQL_POOL_MAX: wholeNumber(10, 1, 10_000),
    SQL_POOL_MIN: wholeNumber(0, 0, 10_000),
    SQL_POOL_IDLE_TIMEOUT: wholeNumber(30000, 1, MAX_TIMER_MS),
    SQL_ENCRYPT: z.string().optional(),
    SQL_TRUST_SERVER_CERT: z.string().optional(),
    SQL_TRUST_SERVER_CERTIFICATE: z.string().optional(),
    SQL_RETRY_MAX_RETRIES: wholeNumber(3, 0, 100),
    SQL_RETRY_DELAY_MS: wholeNumber(1000, 0, MAX_TIMER_MS),
    SQL_RETRY_MAX_DELAY_MS: optionalWholeNumber(0, MAX_TIMER_MS),
    CACHE_TTL_MS: wholeNumber(300000, 0, Number.MAX_SAFE_INTEGER),
    SQL_MAX_ROWS: wholeNumber(1000, 1, Number.MAX_SAFE_INTEGER),
    SQL_ALLOWED_DATABASES: list(),
    SQL_ALLOWED_PROCEDURES: list(),
    LOG_LEVEL: z
      .string()
      .optional()
      .transform((value) => value?.trim().toLowerCase() || 'info')
      .pipe(z.enum(LOG_LEVELS)),
  })
  .superRefine((env, ctx) => {
    if (env.SQL_POOL_MIN > env.SQL_POOL_MAX) {
      ctx.addIssue({ code: 'custom', path: ['SQL_POOL_MIN'], message: `must not exceed SQL_POOL_MAX (${env.SQL_POOL_MAX})` });
    }
  });

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Builds the server configuration from environment variables, throwing ConfigError on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const name = issue.path.join('.');
        const raw = typeof issue.path[0] === 'string' ? env[issue.path[0]] : undefined;
        return `${name}: ${issue.message}${raw !== undefined ? ` (got ${JSON.stringify(raw)})` : ''}`;
      })
    );
  }
  const e = parsed.data;

  return {
    user: e.SQL_USER,
    password: e.SQL_PASSWORD,
    server: e.SQL_SERVER,
    database: e.SQL_DATABASE,
    port: e.SQL_PORT,
    connectionTimeout: e.SQL_CONNECTION_TIMEOUT,
    requestTimeout: e.SQL_REQUEST_TIMEOUT,
    pool: {
      max: e.SQL_POOL_MAX,
      min: e.SQL_POOL_MIN,
      idleTimeoutMillis: e.SQL_POOL_IDLE_TIMEOUT,
    },
    options: {
      // Encrypted unless SQL_ENCRYPT is exactly "false"
      encrypt: e.SQL_ENCRYPT !== 'false',
      trustServerCertificate: e.SQL_TRUST_SERVER_CERT === 'true' || e.SQL_TRUST_SERVER_CERTIFICATE === 'true',
    },
    maxRetries: e.SQL_RETRY_MAX_RETRIES,
    initialRetryDelay: e.SQL_RETRY_DELAY_MS,
    // Defaults to ten times the initial retry delay
    maxRetryDelay: e.SQL_RETRY_MAX_DELAY_MS ?? e.SQL_RETRY_DELAY_MS * 10,
    schemaCacheTTL: e.CACHE_TTL_MS,
    maxRows: e.SQL_MAX_ROWS,
    allowedDatabases: e.SQL_ALLOWED_DATABASES,
    allowedProcedures: e.SQL_ALLOWED_PROCEDURES,
    logLevel: e.LOG_LEVEL,
  };
}
