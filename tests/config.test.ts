import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config.js';

function configError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error: unknown) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig defaults', () => {
  it('uses the documented defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      user: 'sa',
      password: 'yourStrong(!)Password',
      server: 'localhost',
      database: 'master',
      port: 1433,
      connectionTimeout: 15000,
      requestTimeout: 15000,
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
      options: { encrypt: true, trustServerCertificate: false },
      maxRetries: 3,
      initialRetryDelay: 1000,
      maxRetryDelay: 10000,
      schemaCacheTTL: 300000,
      maxRows: 1000,
      allowedDatabases: [],
      allowedProcedures: [],
      logLevel: 'info',
    });
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({ SQL_USER: '', SQL_PASSWORD: '', SQL_PORT: '', SQL_MAX_ROWS: '', LOG_LEVEL: '' });
    expect(config.user).toBe('sa');
    expect(config.password).toBe('yourStrong(!)Password');
    expect(config.port).toBe(1433);
    expect(config.maxRows).toBe(1000);
    expect(config.logLevel).toBe('info');
  });

  it('derives the maximum retry delay from the initial delay when it is not set', () => {
    expect(loadConfig({ SQL_RETRY_DELAY_MS: '250' }).maxRetryDelay).toBe(2500);
    expect(loadConfig({ SQL_RETRY_DELAY_MS: '250', SQL_RETRY_MAX_DELAY_MS: '700' }).maxRetryDelay).toBe(700);
  });
});

describe('loadConfig values', () => {
  it('reads every variable', () => {
    const config = loadConfig({
      SQL_USER: 'reader',
      SQL_PASSWORD: 'secret',
      SQL_SERVER: 'db.local',
      SQL_DATABASE: 'Sales',
      SQL_PORT: '14330',
      SQL_CONNECTION_TIMEOUT: '5000',
      SQL_REQUEST_TIMEOUT: '0',
      SQL_POOL_MAX: '4',
      SQL_POOL_MIN: '1',
      SQL_POOL_IDLE_TIMEOUT: '1000',
      SQL_RETRY_MAX_RETRIES: '0',
      SQL_RETRY_DELAY_MS: '10',
      SQL_RETRY_MAX_DELAY_MS: '20',
      CACHE_TTL_MS: '0',
      SQL_MAX_ROWS: '50',
      LOG_LEVEL: 'debug',
    });
    expect(config).toMatchObject({
      user: 'reader',
      password: 'secret',
      server: 'db.local',
      database: 'Sales',
      port: 14330,
      connectionTimeout: 5000,
      requestTimeout: 0,
      pool: { max: 4, min: 1, idleTimeoutMillis: 1000 },
      maxRetries: 0,
      initialRetryDelay: 10,
      maxRetryDelay: 20,
      schemaCacheTTL: 0,
      maxRows: 50,
      logLevel: 'debug',
    });
  });

  it('trims whitespace around numbers', () => {
    expect(loadConfig({ SQL_PORT: ' 1500 ' }).port).toBe(1500);
  });

  it('keeps the TLS rules: encrypt unless "false", trust only when "true"', () => {
    expect(loadConfig({ SQL_ENCRYPT: 'false' }).options.encrypt).toBe(false);
    expect(loadConfig({ SQL_ENCRYPT: 'no' }).options.encrypt).toBe(true);
    expect(loadConfig({ SQL_TRUST_SERVER_CERT: 'true' }).options.trustServerCertificate).toBe(true);
    expect(loadConfig({ SQL_TRUST_SERVER_CERTIFICATE: 'true' }).options.trustServerCertificate).toBe(true);
    expect(loadConfig({ SQL_TRUST_SERVER_CERT: 'yes' }).options.trustServerCertificate).toBe(false);
  });

  it('splits and trims the allow-lists, dropping empty entries', () => {
    const config = loadConfig({ SQL_ALLOWED_DATABASES: ' Sales , ,HR,', SQL_ALLOWED_PROCEDURES: 'dbo.A, [rpt].[B] ,' });
    expect(config.allowedDatabases).toEqual(['Sales', 'HR']);
    expect(config.allowedProcedures).toEqual(['dbo.A', '[rpt].[B]']);
  });
});

describe('loadConfig validation', () => {
  it.each([
    ['SQL_PORT', 'abc'],
    ['SQL_PORT', '1433abc'],
    ['SQL_PORT', '14.5'],
    ['SQL_PORT', '0'],
    ['SQL_PORT', '65536'],
    ['SQL_CONNECTION_TIMEOUT', '-1'],
    ['SQL_REQUEST_TIMEOUT', '3000000000'],
    ['SQL_POOL_MAX', '0'],
    ['SQL_POOL_IDLE_TIMEOUT', '0'],
    ['SQL_RETRY_MAX_RETRIES', 'NaN'],
    ['SQL_RETRY_MAX_DELAY_MS', 'soon'],
    ['CACHE_TTL_MS', '-5'],
    ['SQL_MAX_ROWS', '0'],
    ['SQL_MAX_ROWS', '   '],
  ])('rejects %s=%j', (name, value) => {
    const error = configError({ [name]: value });
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toContain(name);
    expect(error.issues[0]).toContain(JSON.stringify(value));
  });

  it.each(['Info', 'INFO', ' debug '])('accepts the log level %j regardless of case and padding', (value) => {
    expect(loadConfig({ LOG_LEVEL: value }).logLevel).toBe(value.trim().toLowerCase());
  });

  it('rejects an unknown log level', () => {
    expect(configError({ LOG_LEVEL: 'verbose' }).issues[0]).toContain('LOG_LEVEL');
  });

  it('rejects a pool minimum above the maximum', () => {
    expect(configError({ SQL_POOL_MIN: '5', SQL_POOL_MAX: '2' }).issues[0]).toContain('SQL_POOL_MIN');
  });

  it('reports every invalid variable at once', () => {
    const error = configError({ SQL_PORT: 'x', SQL_MAX_ROWS: '-1' });
    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain('SQL_PORT');
    expect(error.message).toContain('SQL_MAX_ROWS');
  });
});
