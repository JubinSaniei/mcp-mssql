import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { ErrorType, MssqlMcpError } from '../errors.js';

interface FakeError { code?: string; number?: number; message: string; name?: string; originalError?: { number?: number } }

interface Scenario {
  recordsets?: Array<{ columns: string[]; rows: unknown[][] }>;
  error?: FakeError;
  output?: Record<string, unknown>;
  returnValue?: unknown;
  rollbackError?: FakeError;
  onRow?: (row: unknown) => void;
  /** Makes pool.connect() fail with this error, after sending these login error numbers. */
  connectError?: FakeError;
  loginErrorNumbers?: number[];
}

interface FakePoolConfig {
  database: string;
  beforeConnect?: (connection: import('node:events').EventEmitter) => void;
}

/** Shared state between the fake driver and the tests. */
const h = vi.hoisted(() => ({
  events: [] as string[],
  pools: [] as Array<{ config: FakePoolConfig; closed: boolean; connected: boolean }>,
  validatorCalls: [] as Array<{ query: string; options: { allowedDatabases: readonly string[] } }>,
  connections: [] as Array<{ closed: boolean }>,
  requests: [] as Array<{ command?: string; params: Array<{ direction: string; name: string; value: unknown }>; stream: boolean; arrayRowMode: boolean }>,
  rowsEmitted: 0,
  scenario: {} as Scenario,
}));

vi.mock('mssql', async (importOriginal) => {
  const actual = (await importOriginal()) as { default?: Record<string, unknown> } & Record<string, unknown>;
  const base = (actual.default ?? actual) as Record<string, unknown>;
  const { EventEmitter } = await import('node:events');
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const toError = (spec: FakeError) => Object.assign(new Error(spec.message), spec);

  class FakeConnectionPool extends EventEmitter {
    connected = false;
    closed = false;
    constructor(public config: FakePoolConfig) {
      super();
      h.pools.push(this);
    }
    async connect() {
      const { connectError, loginErrorNumbers = [] } = h.scenario;
      if (connectError) {
        const connection = new EventEmitter();
        this.config.beforeConnect?.(connection);
        for (const number of loginErrorNumbers) connection.emit('errorMessage', { number, message: `error ${number}` });
        connection.emit('connect', toError(connectError));
        await tick();
        throw toError(connectError);
      }
      this.connected = true;
      return this;
    }
    async close() {
      this.connected = false;
      this.closed = true;
    }
    request() {
      return new FakeRequest(null);
    }
  }

  class FakeTransaction {
    activeRequest: unknown = null;
    _acquiredConnection: { closed: boolean; close: () => void } | null = null;
    constructor(public pool: FakeConnectionPool) {}
    async begin() {
      h.events.push('begin');
      const connection = {
        closed: false,
        close() {
          this.closed = true;
          h.events.push('connection-closed');
        },
      };
      h.connections.push(connection);
      this._acquiredConnection = connection;
      return this;
    }
    async rollback() {
      if (this.activeRequest) {
        h.events.push('rollback-while-request-in-progress');
        throw toError({ code: 'EREQINPROG', message: "Can't rollback transaction. There is a request in progress." });
      }
      h.events.push('rollback');
      this._acquiredConnection = null;
      if (h.scenario.rollbackError) throw toError(h.scenario.rollbackError);
    }
  }

  class FakeRequest extends EventEmitter {
    stream = false;
    arrayRowMode = false;
    canceled = false;
    command?: string;
    params: Array<{ direction: string; name: string; value: unknown }> = [];
    constructor(public parent: FakeTransaction | null) {
      super();
      h.requests.push(this);
    }
    input(name: string, _type: unknown, value: unknown) {
      this.params.push({ direction: 'in', name, value });
      return this;
    }
    output(name: string, _type: unknown, value: unknown) {
      this.params.push({ direction: 'out', name, value });
      return this;
    }
    cancel() {
      this.canceled = true;
      h.events.push('cancel');
    }
    query(command: string) {
      this.command = command;
      return this.run();
    }
    execute(command: string) {
      this.command = command;
      return this.run();
    }
    private async run() {
      if (this.parent) this.parent.activeRequest = this;
      h.events.push('request-start');
      const scenario = h.scenario;
      outer: for (const rs of scenario.recordsets ?? []) {
        await tick();
        if (this.canceled) break;
        this.emit('recordset', rs.columns.map((name, index) => ({ name, index })));
        for (const row of rs.rows) {
          await tick();
          if (this.canceled) break outer;
          h.rowsEmitted++;
          this.emit('row', row);
          scenario.onRow?.(row);
        }
      }
      await tick();
      if (this.canceled) this.emit('error', toError({ name: 'RequestError', code: 'ECANCEL', message: 'Canceled.' }));
      else if (scenario.error) this.emit('error', toError(scenario.error));
      if (this.parent) this.parent.activeRequest = null;
      h.events.push('request-done');
      this.emit('done', { output: scenario.output ?? {}, returnValue: scenario.returnValue, rowsAffected: [] });
      return {};
    }
  }

  return { default: { ...base, ConnectionPool: FakeConnectionPool, Transaction: FakeTransaction, Request: FakeRequest } };
});

vi.mock('../queryValidator.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../queryValidator.js');
  return {
    ...actual,
    validateReadOnlyQuery: (query: string, options: { allowedDatabases: readonly string[] }) => {
      h.validatorCalls.push({ query, options });
      return actual.validateReadOnlyQuery(query, options);
    },
  };
});

const { DatabaseService } = await import('../DatabaseService.js');
const { databaseNameKey, normalizeDatabaseName } = await import('../databaseName.js');
type Config = ConstructorParameters<typeof DatabaseService>[0];

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), isLevelEnabled: () => false };
}

function makeService(overrides: Partial<Config> = {}) {
  const logger = makeLogger();
  const config: Config = {
    server: 'localhost',
    port: 1433,
    user: 'u',
    password: 'p',
    database: 'Main',
    maxRetries: 1,
    initialRetryDelay: 1,
    maxRetryDelay: 1,
    schemaCacheTTL: 60000,
    maxRows: 3,
    allowedDatabases: [],
    allowedProcedures: ['dbo.GetX'],
    ...overrides,
  };
  return { service: new DatabaseService(config, logger as unknown as Logger), logger };
}

const numbers = (count: number) => Array.from({ length: count }, (_, i) => [i]);

async function rejection(promise: Promise<unknown>): Promise<MssqlMcpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MssqlMcpError);
    return error as MssqlMcpError;
  }
  throw new Error('expected a rejection');
}

/** Rollback must come after the request finished, never while it is in progress. */
function expectRollbackAfterRequest() {
  expect(h.events).not.toContain('rollback-while-request-in-progress');
  expect(h.events.lastIndexOf('rollback')).toBeGreaterThan(h.events.lastIndexOf('request-done'));
}

beforeEach(() => {
  h.events.length = 0;
  h.pools.length = 0;
  h.connections.length = 0;
  h.requests.length = 0;
  h.validatorCalls.length = 0;
  h.rowsEmitted = 0;
  h.scenario = {};
});

describe('executeQuery streaming inside the rollback-only transaction', () => {
  it('stops the stream once the page has one row too many, then rolls back', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: numbers(10) }] };
    const { service } = makeService();

    const result = await service.executeQuery('SELECT n FROM t ORDER BY n', undefined, 0, 2);

    expect(result.recordsets[0].rows).toEqual([[0], [1]]);
    expect(result.recordsets[0].hasMore).toBe(true);
    expect(result.pagination).toEqual({ offset: 0, limit: 2, hasMore: true, nextOffset: 2, returnedRowCount: 2 });
    expect(h.rowsEmitted).toBe(3);
    expect(h.events).toEqual(['begin', 'request-start', 'cancel', 'request-done', 'rollback']);
    expect(h.requests[0]).toMatchObject({ stream: true, arrayRowMode: true });
  });

  it('applies offset and reports the last page', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: numbers(5) }] };
    const { service } = makeService();
    const result = await service.executeQuery('SELECT n FROM t ORDER BY n', undefined, 3, 2);
    expect(result.recordsets[0].rows).toEqual([[3], [4]]);
    expect(result.pagination.hasMore).toBe(false);
    expect(h.events).not.toContain('cancel');
    expectRollbackAfterRequest();
  });

  it('caps limit at maxRows', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: numbers(10) }] };
    const { service } = makeService();
    const result = await service.executeQuery('SELECT n FROM t', undefined, undefined, 500);
    expect(result.pagination.limit).toBe(3);
    expect(result.recordsets[0].rows).toHaveLength(3);
  });

  it('cancels the SQL when the client aborts, and still rolls back after the request is done', async () => {
    const controller = new AbortController();
    h.scenario = { recordsets: [{ columns: ['n'], rows: numbers(10) }], onRow: () => controller.abort() };
    const { service } = makeService({ maxRows: 100 });

    const error = await rejection(service.executeQuery('SELECT n FROM t', undefined, 0, 100, { signal: controller.signal }));

    expect(error.errorType).toBe(ErrorType.CANCELLED);
    expect(h.rowsEmitted).toBe(1);
    expect(h.events).toEqual(['begin', 'request-start', 'cancel', 'request-done', 'rollback']);
  });

  it('does not touch the database when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service } = makeService();
    const error = await rejection(service.executeQuery('SELECT 1', undefined, 0, 1, { signal: controller.signal }));
    expect(error.errorType).toBe(ErrorType.CANCELLED);
    expect(h.pools).toHaveLength(0);
  });

  it('returns SQL errors with their number and rolls back', async () => {
    h.scenario = { error: { name: 'RequestError', code: 'EREQUEST', number: 208, message: "Invalid object name 't'." } };
    const { service } = makeService();
    const error = await rejection(service.executeQuery('SELECT n FROM t'));
    expect(error.errorType).toBe(ErrorType.QUERY_ERROR);
    expect(error.sqlErrorNumber).toBe(208);
    expect(error.code).toBe('EREQUEST');
    expectRollbackAfterRequest();
  });

  it('validates the query before any SQL runs', async () => {
    const { service } = makeService();
    await rejection(service.executeQuery('DELETE FROM t'));
    await rejection(service.executeQuery("SELECT 'a\\' ; SELECT 2; --'"));
    expect(h.pools).toHaveLength(0);
    expect(h.events).toEqual([]);
  });
});

describe('connection pools', () => {
  it('reuses one pool per database, case-insensitively', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService();
    await service.executeQuery('SELECT 1');
    await service.executeQuery('SELECT 1', 'main');
    await service.executeQuery('SELECT 1', 'Other');
    await service.executeQuery('SELECT 1', '[OTHER]');
    expect(h.pools.map((p) => p.config.database)).toEqual(['Main', 'Other']);
  });

  it('runs concurrent first calls on one connection attempt', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService();
    await Promise.all([service.executeQuery('SELECT 1'), service.executeQuery('SELECT 1'), service.executeQuery('SELECT 1')]);
    expect(h.pools).toHaveLength(1);
  });

  it('rebuilds the pool after a lost connection, without retrying the query', async () => {
    h.scenario = { error: { name: 'ConnectionError', code: 'ESOCKET', message: 'socket hang up' } };
    const { service } = makeService();
    const error = await rejection(service.executeQuery('SELECT 1'));
    expect(error.errorType).toBe(ErrorType.CONNECTION_ERROR);
    expect(h.requests).toHaveLength(1);
    await Promise.resolve();
    expect(h.pools[0].closed).toBe(true);

    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    await service.executeQuery('SELECT 1');
    expect(h.pools).toHaveLength(2);
  });

  it('closes every pool on closeAll and refuses later calls', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService();
    await service.executeQuery('SELECT 1');
    await service.executeQuery('SELECT 1', 'Other');
    await service.closeAll();
    expect(h.pools.every((p) => p.closed)).toBe(true);
    expect((await rejection(service.executeQuery('SELECT 1'))).errorType).toBe(ErrorType.CONNECTION_ERROR);
  });
});

describe('normalizeDatabaseName', () => {
  it('removes one layer of delimiters, decodes escapes and trims', () => {
    expect(normalizeDatabaseName(' Main ')).toBe('Main');
    expect(normalizeDatabaseName('[Main]')).toBe('Main');
    expect(normalizeDatabaseName(' [ Main ] ')).toBe('Main');
    expect(normalizeDatabaseName('"Main"')).toBe('Main');
    expect(normalizeDatabaseName('[Ma]]in]')).toBe('Ma]in');
    expect(normalizeDatabaseName('"Ma""in"')).toBe('Ma"in');
    expect(normalizeDatabaseName('[[Main]]')).toBe('[Main]');
    expect(normalizeDatabaseName('[Main')).toBe('[Main');
    expect(databaseNameKey('[MAIN]')).toBe('main');
  });
});

/** The service's cached pool entries, keyed by lower-cased database name. */
function poolKeys(service: object): string[] {
  return [...(service as { pools: Map<string, unknown> }).pools.keys()];
}

describe('database allow-list', () => {
  it('rejects an unlisted database before validating, connecting or running SQL', async () => {
    const { service } = makeService({ allowedDatabases: ['Main'] });

    const error = await rejection(service.executeQuery('SELECT 1', 'Other'));

    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.message).toContain("'Other'");
    expect(error.message).toContain('does not exist');
    expect(error.message).toContain('Allowed databases: Main');
    expect(h.validatorCalls).toHaveLength(0);
    expect(h.pools).toHaveLength(0);
    expect(h.events).toEqual([]);
    expect(poolKeys(service)).toEqual([]);
  });

  it('rejects an unlisted database for schema retrieval and stored procedures too', async () => {
    const { service } = makeService({ allowedDatabases: ['Main'] });
    expect((await rejection(service.getSchema('Other'))).errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect((await rejection(service.executeStoredProcedure('dbo.GetX', [], 'Other'))).errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(h.pools).toHaveLength(0);
  });

  it('accepts bracketed, quoted, upper-case and padded names and connects with the allow-list spelling', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService({ database: 'Home', allowedDatabases: ['Home', 'Main'] });

    for (const name of ['[Main]', 'MAIN', ' main ', '"Main"', 'Main']) {
      await service.executeQuery('SELECT 1', name);
    }

    expect(h.pools.map((p) => p.config.database)).toEqual(['Main']);
    expect(poolKeys(service)).toEqual(['main']);
  });

  it('accepts the bracketed default database when it is the allowed one', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService({ allowedDatabases: ['Main'] });
    await service.executeQuery('SELECT 1', '[Main]');
    await service.executeQuery('SELECT 1', 'MAIN');
    expect(h.pools.map((p) => p.config.database)).toEqual(['Main']);
  });

  it('normalises allow-list entries the same way as requested names', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService({ allowedDatabases: ['Main', ' [Sales] '] });
    await service.executeQuery('SELECT 1', 'SALES');
    expect(h.pools.map((p) => p.config.database)).toEqual(['Sales']);
  });

  it('passes the allow-list spellings, without delimiters, to the query validator', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService({ allowedDatabases: ['[Main]', ' SALES ', 'main'] });
    await service.executeQuery('SELECT 1');
    expect(h.validatorCalls).toHaveLength(1);
    expect(h.validatorCalls[0].options.allowedDatabases).toEqual(['Main', 'SALES']);
  });

  it('accepts the database argument in any case but names in the query only as spelled in the allow-list', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService({ allowedDatabases: ['Sales'] });

    await service.executeQuery('SELECT * FROM Sales.dbo.t', 'SALES');
    expect(h.pools.map((p) => p.config.database)).toEqual(['Sales']);

    const error = await rejection(service.executeQuery('SELECT * FROM SALES.dbo.t', 'Sales'));
    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.details).toMatchObject({ reason: 'database_not_allowed', database: 'SALES', allowedSpelling: 'Sales' });
    expect(error.message).toContain('use [Sales]');
    expect(h.requests).toHaveLength(1);
  });

  it('passes an empty allow-list to the query validator when none is set', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService();
    await service.executeQuery('SELECT 1');
    expect(h.validatorCalls[0].options.allowedDatabases).toEqual([]);
  });
});

describe('connection failures', () => {
  const loginFailed = { name: 'ConnectionError', code: 'ELOGIN', message: "Login failed for user 'u'." };

  it('reports a database that cannot be opened (4060) clearly, without retrying, and drops its pool entry', async () => {
    h.scenario = { connectError: loginFailed, loginErrorNumbers: [4060, 18456] };
    const { service } = makeService({ maxRetries: 3 });

    const error = await rejection(service.executeQuery('SELECT 1', 'Missing'));

    expect(error.errorType).toBe(ErrorType.CONNECTION_ERROR);
    expect(error.code).toBe('ELOGIN');
    expect(error.sqlErrorNumber).toBe(4060);
    expect(error.message).toBe("Cannot open database 'Missing': it does not exist, or the login cannot access it.");
    expect(h.pools).toHaveLength(1);
    expect(h.events).toEqual([]);
    expect(poolKeys(service)).toEqual([]);
  });

  it('starts a new pool entry on the next call after a failed connection', async () => {
    h.scenario = { connectError: loginFailed, loginErrorNumbers: [4060, 18456] };
    const { service } = makeService();
    await rejection(service.executeQuery('SELECT 1', 'Later'));

    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    await service.executeQuery('SELECT 1', 'Later');
    expect(h.pools).toHaveLength(2);
    expect(poolKeys(service)).toEqual(['later']);
  });

  it('keeps the generic message for other login failures', async () => {
    h.scenario = { connectError: loginFailed, loginErrorNumbers: [18456] };
    const { service } = makeService({ maxRetries: 3 });

    const error = await rejection(service.executeQuery('SELECT 1', 'Other'));

    expect(error.errorType).toBe(ErrorType.CONNECTION_ERROR);
    expect(error.sqlErrorNumber).toBeUndefined();
    expect(error.message).toContain("Failed to connect to SQL Server database 'Other'");
    expect(h.pools).toHaveLength(1);
    expect(poolKeys(service)).toEqual([]);
  });

  it('drops the pool entry after retries of a network failure run out', async () => {
    h.scenario = { connectError: { name: 'ConnectionError', code: 'ESOCKET', message: 'connect ECONNREFUSED' } };
    const { service } = makeService({ maxRetries: 2 });

    const error = await rejection(service.executeQuery('SELECT 1', 'Other'));

    expect(error.errorType).toBe(ErrorType.CONNECTION_ERROR);
    expect(h.pools).toHaveLength(2);
    expect(poolKeys(service)).toEqual([]);
  });

  it('shares one failed attempt between concurrent callers', async () => {
    h.scenario = { connectError: loginFailed, loginErrorNumbers: [4060] };
    const { service } = makeService();
    const errors = await Promise.all([
      rejection(service.executeQuery('SELECT 1', 'Missing')),
      rejection(service.executeQuery('SELECT 1', '[missing]')),
    ]);
    expect(errors.map((e) => e.sqlErrorNumber)).toEqual([4060, 4060]);
    expect(h.pools).toHaveLength(1);
    expect(poolKeys(service)).toEqual([]);
  });

  it('rejects a name with brackets left after removing its delimiters', async () => {
    const { service } = makeService();
    const error = await rejection(service.executeQuery('SELECT 1', '[Ma]]in]'));
    expect(error.errorType).toBe(ErrorType.VALIDATION_ERROR);
    expect(h.pools).toHaveLength(0);
  });
});

describe('rollback failures', () => {
  it('treats EABORT as already rolled back and keeps the pool', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }], rollbackError: { code: 'EABORT', message: 'Transaction has been aborted.' } };
    const { service } = makeService();
    await service.executeQuery('SELECT 1');
    await service.executeQuery('SELECT 1');
    expect(h.pools).toHaveLength(1);
    expect(h.events).not.toContain('connection-closed');
  });

  it('treats error 3903 as already ended and keeps the pool', async () => {
    h.scenario = {
      recordsets: [{ columns: ['n'], rows: [[1]] }],
      rollbackError: { code: 'EREQUEST', message: 'The ROLLBACK TRANSACTION request has no corresponding BEGIN TRANSACTION.', originalError: { number: 3903 } },
    };
    const { service } = makeService();
    await service.executeQuery('SELECT 1');
    await service.executeQuery('SELECT 1');
    expect(h.pools).toHaveLength(1);
    expect(h.events).not.toContain('connection-closed');
  });

  it('reads error 3903 from the error itself as well as from its originalError', async () => {
    h.scenario = {
      recordsets: [{ columns: ['n'], rows: [[1]] }],
      rollbackError: { name: 'RequestError', code: 'EREQUEST', message: 'Rollback failed.', number: 3903 },
    };
    const { service } = makeService();
    await service.executeQuery('SELECT 1');
    await service.executeQuery('SELECT 1');
    expect(h.pools).toHaveLength(1);
    expect(h.events).not.toContain('connection-closed');
  });

  it('does not classify a rollback error by its message text', async () => {
    h.scenario = {
      recordsets: [{ columns: ['n'], rows: [[1]] }],
      rollbackError: { code: 'EREQUEST', message: 'The ROLLBACK TRANSACTION request has no corresponding BEGIN TRANSACTION.' },
    };
    const { service } = makeService();
    await service.executeQuery('SELECT 1');
    expect(h.connections[0].closed).toBe(true);
    await Promise.resolve();
    expect(h.pools[0].closed).toBe(true);
  });

  it('closes the connection and retires the pool when the rollback may have left a transaction open', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }], rollbackError: { code: 'EREQUEST', message: 'rollback failed' } };
    const { service, logger } = makeService();

    const result = await service.executeQuery('SELECT 1');
    expect(result.recordsets[0].rows).toEqual([[1]]);
    expect(h.connections[0].closed).toBe(true);
    expect(logger.error).toHaveBeenCalled();
    await Promise.resolve();
    expect(h.pools[0].closed).toBe(true);

    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    await service.executeQuery('SELECT 1');
    expect(h.pools).toHaveLength(2);
  });

  it('keeps the original SQL error when the rollback also fails', async () => {
    h.scenario = {
      error: { name: 'RequestError', code: 'EREQUEST', number: 207, message: "Invalid column name 'x'." },
      rollbackError: { code: 'EREQUEST', message: 'rollback failed' },
    };
    const { service } = makeService();
    const error = await rejection(service.executeQuery('SELECT x FROM t'));
    expect(error.sqlErrorNumber).toBe(207);
  });
});

describe('executeStoredProcedure', () => {
  it('runs an allowed procedure by its canonical name with typed in and out parameters', async () => {
    h.scenario = {
      recordsets: [{ columns: ['id', 'id', ''], rows: numbers(5).map(([n]) => [n, n, 'x']) }, { columns: ['total'], rows: [[9]] }],
      output: { Total: 42 },
      returnValue: 0,
    };
    const { service } = makeService();

    const result = await service.executeStoredProcedure(
      '[DBO].[getx]',
      [
        { name: '@Id', type: 'INT', value: 7 },
        { name: 'Total', type: 'decimal', precision: 18, scale: 2, direction: 'out' },
      ]
    );

    expect(h.requests[0].command).toBe('DBO.getx');
    expect(h.requests[0].params).toEqual([
      { direction: 'in', name: 'Id', value: 7 },
      { direction: 'out', name: 'Total', value: undefined },
    ]);
    expect(result.outputParameters).toEqual({ Total: 42 });
    expect(result.returnValue).toBe(0);
    expect(result.recordsets[0].columns).toEqual(['id', 'id', '']);
    expect(result.recordsets[0].rows).toHaveLength(3);
    expect(result.recordsets[0].hasMore).toBe(true);
    expect(result.recordsets[1]).toEqual({ columns: ['total'], rows: [[9]], recordCount: 1, hasMore: false });
    expect(h.events).not.toContain('cancel');
    expectRollbackAfterRequest();
  });

  it('renders date/time output parameters as SQL text at their declared scale', async () => {
    const when = new Date(Date.UTC(2026, 9, 1, 12, 34, 56, 123));
    Object.defineProperty(when, 'nanosecondsDelta', { value: 0.0004567 });
    h.scenario = { output: { When: when, Day: new Date(Date.UTC(2026, 9, 1)), Total: 42 }, returnValue: 0 };
    const { service } = makeService();

    const result = await service.executeStoredProcedure('dbo.GetX', [
      { name: 'When', type: 'datetime2', direction: 'out' },
      { name: '@Day', type: 'date', direction: 'out' },
      { name: 'Total', type: 'int', direction: 'out' },
    ]);

    expect(result.outputParameters).toEqual({ When: '2026-10-01T12:34:56.1234567', Day: '2026-10-01', Total: 42 });
  });

  it('connects with UTC date handling', async () => {
    h.scenario = { recordsets: [{ columns: ['n'], rows: [[1]] }] };
    const { service } = makeService({ options: { encrypt: true } });
    await service.executeQuery('SELECT 1');
    const config = h.pools[0].config as unknown as { options: { useUTC?: boolean; encrypt?: boolean } };
    expect(config.options).toMatchObject({ useUTC: true, encrypt: true });
    expect(service.dateTimeOffsetMode).toBe('offset-preserved');
  });

  it('rejects procedures that are not allowed without listing the allowed ones', async () => {
    const { service } = makeService({ allowedProcedures: ['dbo.GetX', 'dbo.Secret'] });
    const error = await rejection(service.executeStoredProcedure('dbo.Other'));
    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.message).toContain('dbo.Other');
    expect(error.message).not.toContain('Secret');
    expect(h.pools).toHaveLength(0);
  });

  it('rejects unqualified names with a validation error', async () => {
    const { service } = makeService();
    const error = await rejection(service.executeStoredProcedure('GetX'));
    expect(error.errorType).toBe(ErrorType.VALIDATION_ERROR);
    expect(h.pools).toHaveLength(0);
  });

  it('rejects unknown parameter types before any SQL runs', async () => {
    const { service } = makeService();
    const error = await rejection(service.executeStoredProcedure('dbo.GetX', [{ name: 'a', type: 'string', value: 'x' }]));
    expect(error.errorType).toBe(ErrorType.VALIDATION_ERROR);
    expect(h.pools).toHaveLength(0);
  });

  it('ignores unqualified allow-list entries with a warning', () => {
    const { service, logger } = makeService({ allowedProcedures: ['GetX', 'bad name', 'rpt.[Monthly]'] });
    expect(service.allowedProcedureCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
