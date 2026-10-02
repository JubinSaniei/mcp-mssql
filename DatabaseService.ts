import sql from 'mssql';
import { Logger } from 'pino';
import { MssqlMcpError, ErrorType, classifyError, extractDriverErrorInfo, toMssqlMcpError } from './errors.js';
import { validateReadOnlyQuery } from './queryValidator.js';
import {
  RecordsetPager,
  buildQueryResult,
  resolvePageWindow,
  type QueryResult,
  type Recordset,
} from './resultFormat.js';
import {
  buildAllowedProcedureSet,
  prepareProcedureParameter,
  requireProcedureName,
  type ProcedureParameterInput,
} from './procedures.js';
import { SCHEMA_QUERY, buildTableSchemas, type ForeignKeyRow, type SchemaColumnRow, type TableSchema } from './schemaModel.js';
import { formatOutputParameters } from './temporalFormat.js';
import { installDateTimeOffsetPatch, type DateTimeOffsetMode } from './datetimeoffsetPatch.js';
import { databaseNameKey, normalizeDatabaseName } from './databaseName.js';

export type { QueryResult, Recordset, TableSchema, ProcedureParameterInput };

// Default maximum rows returned per recordset if not configured
const DEFAULT_MAX_ROWS = 1000;

// SQL Server error number for "The ROLLBACK TRANSACTION request has no corresponding BEGIN TRANSACTION."
const SQL_ERROR_NO_CORRESPONDING_BEGIN_TRAN = 3903;

// SQL Server error number for "Cannot open database requested by the login."
const SQL_ERROR_CANNOT_OPEN_DATABASE = 4060;

// Pools for databases other than the default one are closed after this long without use
const POOL_IDLE_TTL_MS = 10 * 60 * 1000;
const POOL_SWEEP_INTERVAL_MS = 60 * 1000;

// Define SqlConfig interface
export interface SqlConfig {
  server: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  requestTimeout?: number;
  connectionTimeout?: number;
  maxRetries: number;
  initialRetryDelay: number;
  maxRetryDelay: number;
  schemaCacheTTL: number;
  maxRows?: number;
  allowedDatabases?: string[];
  // Procedures execute_stored_procedure may run, as `schema.proc` names. Empty = none.
  allowedProcedures: string[];
  options?: {
    encrypt?: boolean;
    trustServerCertificate?: boolean;
  };
  pool?: {
    min?: number;
    max?: number;
    idleTimeoutMillis?: number;
  };
  logLevel?: string;
}

export interface StoredProcedureResult {
  /** Result sets, each capped at maxRows rows; `hasMore` marks a capped result set. */
  recordsets: Recordset[];
  outputParameters: Record<string, unknown>;
  returnValue: unknown;
  rowsAffected: number[];
}

export interface OperationOptions {
  /** Aborting this signal cancels the running SQL; the transaction is still rolled back. */
  signal?: AbortSignal;
}

/** One cached connection pool, keyed by lower-cased database name. */
interface PoolEntry {
  key: string;
  database: string;
  pool: sql.ConnectionPool | null;
  connecting: Promise<sql.ConnectionPool> | null;
  /** Operations currently using this entry. */
  active: number;
  lastUsed: number;
  /** A retired entry is no longer handed out; its pool is closed once `active` reaches 0. */
  retired: boolean;
}

type RollbackOutcome = 'rolled-back' | 'already-ended' | 'unsafe';

interface StreamOutcome {
  output: Record<string, unknown>;
  returnValue: unknown;
  rowsAffected: number[];
}

/** The tedious connection a transaction holds; read only to close it after a failed rollback. */
interface HeldConnection {
  close?: () => void;
}

function cancelledError(): MssqlMcpError {
  return new MssqlMcpError('The request was cancelled by the client.', ErrorType.CANCELLED, undefined, undefined, { code: 'ECANCEL' });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function errorCode(error: unknown): string | undefined {
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function querySnippet(query: string): string {
  return query.length > 100 ? `${query.substring(0, 100)}...` : query;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DatabaseService {
  private readonly pools = new Map<string, PoolEntry>();
  private readonly schemaCache: Map<string, { timestamp: number; data: TableSchema[] }> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private readonly sqlConfig: SqlConfig;
  private readonly logger: Logger;
  // Allowed databases: comparison key -> the name as spelled in the allow-list, without delimiters
  private readonly allowedDatabaseNames: ReadonlyMap<string, string>;
  // Allowed databases as spelled in the allow-list, without delimiters, for the query validator
  private readonly validatorAllowedDatabases: string[];
  // Allowed procedures as lower-cased `schema.proc` keys
  private readonly allowedProcedureKeys: ReadonlySet<string>;
  private readonly defaultDatabase: string;
  private readonly defaultKey: string;
  private readonly maxRows: number;
  /** Whether datetimeoffset values keep their original offset or are rendered in UTC. */
  public readonly dateTimeOffsetMode: DateTimeOffsetMode;

  constructor(sqlConfig: SqlConfig, logger: Logger) {
    this.sqlConfig = sqlConfig;
    this.logger = logger;
    const allowedDatabaseNames = new Map<string, string>();
    for (const entry of sqlConfig.allowedDatabases || []) {
      const name = normalizeDatabaseName(entry);
      const key = name.toLowerCase();
      if (key && !allowedDatabaseNames.has(key)) allowedDatabaseNames.set(key, name);
    }
    this.allowedDatabaseNames = allowedDatabaseNames;
    this.validatorAllowedDatabases = [...allowedDatabaseNames.values()];
    this.allowedProcedureKeys = buildAllowedProcedureSet(sqlConfig.allowedProcedures || [], (entry, reason) => {
      this.logger.warn(
        { entry, reason },
        reason === 'unqualified'
          ? 'DatabaseService: Ignoring SQL_ALLOWED_PROCEDURES entry without a schema; write it as schema.procedure.'
          : 'DatabaseService: Ignoring invalid SQL_ALLOWED_PROCEDURES entry; use schema.procedure with letters, digits and underscores.'
      );
    });
    this.defaultDatabase = normalizeDatabaseName(sqlConfig.database);
    this.defaultKey = this.defaultDatabase.toLowerCase();
    const configuredMaxRows = sqlConfig.maxRows;
    this.maxRows = configuredMaxRows !== undefined && Number.isFinite(configuredMaxRows) && configuredMaxRows >= 1
      ? Math.floor(configuredMaxRows)
      : DEFAULT_MAX_ROWS;
    const datetimeoffset = installDateTimeOffsetPatch();
    this.dateTimeOffsetMode = datetimeoffset.mode;
    if (datetimeoffset.firstAttempt && datetimeoffset.reason !== undefined) {
      this.logger.warn(
        { reason: datetimeoffset.reason },
        'DatabaseService: Could not patch the driver to keep datetimeoffset offsets; datetimeoffset values are returned in UTC (+00:00).'
      );
    }
    this.logger.debug({ datetimeoffsetMode: datetimeoffset.mode }, 'DatabaseService: datetimeoffset rendering mode.');
    this.logger.info('DatabaseService instantiated.');
  }

  /** Number of valid entries in the stored procedure allow-list. */
  public get allowedProcedureCount(): number {
    return this.allowedProcedureKeys.size;
  }

  /** The row cap applied to every result set. */
  public get maxRowsPerRecordset(): number {
    return this.maxRows;
  }

  /**
   * Checks the target database against the allow-list. Names are compared after
   * `normalizeDatabaseName`, case-insensitively. Throws PERMISSION_ERROR if not allowed.
   */
  private assertDatabaseAllowed(targetDatabase: string, operation: string): void {
    if (this.allowedDatabaseNames.size > 0 && !this.allowedDatabaseNames.has(databaseNameKey(targetDatabase))) {
      this.logger.debug({ database: targetDatabase, operation }, 'DatabaseService: Database is not in the whitelist.');
      const allowed = [...this.allowedDatabaseNames.values()];
      throw new MssqlMcpError(
        `Database '${targetDatabase}' is not on this server's list of allowed databases, or it does not exist. Allowed databases: ${allowed.join(', ')}`,
        ErrorType.PERMISSION_ERROR,
        undefined,
        { database: targetDatabase, allowed }
      );
    }
  }

  /**
   * Validates an undelimited database name: letters, digits, underscores, hyphens and spaces.
   */
  private assertValidDatabaseName(dbName: string): void {
    if (!/^[a-zA-Z0-9_\-\s]+$/.test(dbName)) {
      throw new MssqlMcpError(
        `DatabaseService: Invalid database name format: ${dbName}`,
        ErrorType.VALIDATION_ERROR,
        undefined,
        { database: dbName }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Connection pools: one per database, created on first use
  // ---------------------------------------------------------------------------

  /**
   * Maps a caller's database name to its pool key and the name the pool connects with. The
   * default database connects as configured in SQL_DATABASE; with an allow-list, other
   * databases connect as spelled in the allow-list, never as spelled by the caller.
   */
  private resolvePoolTarget(database: string): { key: string; database: string } {
    const key = databaseNameKey(database);
    if (key === this.defaultKey) return { key, database: this.defaultDatabase };
    const allowedName = this.allowedDatabaseNames.get(key);
    if (allowedName === undefined && this.allowedDatabaseNames.size > 0) this.assertDatabaseAllowed(database, 'connection');
    const name = allowedName ?? normalizeDatabaseName(database);
    this.assertValidDatabaseName(name);
    return { key, database: name };
  }

  private entryFor(database: string): PoolEntry {
    if (this.closed) {
      throw new MssqlMcpError('The database service is shutting down.', ErrorType.CONNECTION_ERROR);
    }
    const target = this.resolvePoolTarget(database);
    let entry = this.pools.get(target.key);
    if (!entry) {
      entry = { ...target, pool: null, connecting: null, active: 0, lastUsed: Date.now(), retired: false };
      this.pools.set(target.key, entry);
      this.ensureIdleSweep();
    }
    return entry;
  }

  /** Returns the entry's connected pool, joining a connection attempt already in progress. */
  private connectEntry(entry: PoolEntry): Promise<sql.ConnectionPool> {
    if (entry.pool && entry.pool.connected) return Promise.resolve(entry.pool);
    if (entry.connecting) return entry.connecting;

    if (entry.pool) {
      const stale = entry.pool;
      entry.pool = null;
      this.logger.warn({ database: entry.database }, 'DatabaseService: Pool is no longer connected; replacing it.');
      void this.closePoolQuietly(stale, entry.database);
    }

    const attempt = this.connectWithRetry(entry);
    entry.connecting = attempt;
    const clear = () => { if (entry.connecting === attempt) entry.connecting = null; };
    // A failed attempt retires the entry, so the next call starts from a new one
    attempt.then(clear, () => {
      clear();
      this.retireEntry(entry, 'connection failed');
    });
    return attempt;
  }

  /**
   * Connects a new pool for the entry, retrying with exponential backoff. Concurrent callers
   * share one attempt through `entry.connecting`, so only one retry chain runs per database.
   */
  private async connectWithRetry(entry: PoolEntry): Promise<sql.ConnectionPool> {
    if (!this.sqlConfig.password) {
      this.logger.error('DatabaseService: SQL Server password not provided. Set SQL_PASSWORD environment variable.');
      throw new MssqlMcpError('SQL Server password not provided.', ErrorType.VALIDATION_ERROR, undefined, { missingVariable: 'SQL_PASSWORD' });
    }

    const attempts = Math.max(1, Math.floor(this.sqlConfig.maxRetries) || 1);
    let lastError: unknown;
    // SQL Server error numbers sent while logging in for the attempt that raised `lastError`;
    // the driver's login error itself does not carry them
    let lastLoginErrorNumbers: number[] = [];

    for (let attempt = 0; attempt < attempts && !entry.retired; attempt++) {
      const attemptLoginErrors: number[] = [];
      const pool = new sql.ConnectionPool({
        ...this.sqlConfig,
        database: entry.database,
        requestTimeout: this.sqlConfig.requestTimeout || 30000,
        connectionTimeout: this.sqlConfig.connectionTimeout || 30000,
        // Date/time values are built from UTC fields so they render without the process time zone
        options: { ...this.sqlConfig.options, useUTC: true },
        beforeConnect: (connection) => {
          const onErrorMessage = (token: { number?: unknown }) => {
            if (typeof token.number === 'number') attemptLoginErrors.push(token.number);
          };
          connection.on('errorMessage', onErrorMessage);
          connection.once('connect', () => connection.removeListener('errorMessage', onErrorMessage));
        },
      });
      pool.on('error', (err: Error) => {
        this.logger.error({ err, database: entry.database }, 'DatabaseService: SQL pool reported an error.');
      });

      try {
        this.logger.info(
          { server: this.sqlConfig.server, port: this.sqlConfig.port, database: entry.database, attempt: attempt + 1, attempts },
          'DatabaseService: Connecting pool.'
        );
        await pool.connect();
      } catch (error: unknown) {
        lastError = error;
        lastLoginErrorNumbers = attemptLoginErrors;
        await this.closePoolQuietly(pool, entry.database);
        this.logger.warn({ err: error, database: entry.database, attempt: attempt + 1, attempts }, 'DatabaseService: Connection attempt failed.');
        // A rejected login does not succeed on retry
        if (errorCode(error) === 'ELOGIN' || attempt + 1 >= attempts) break;
        const delay = Math.min(
          this.sqlConfig.initialRetryDelay * Math.pow(2, attempt) + Math.random() * 1000,
          this.sqlConfig.maxRetryDelay
        );
        await sleep(delay);
        continue;
      }

      if (entry.retired) {
        await this.closePoolQuietly(pool, entry.database);
        break;
      }
      entry.pool = pool;
      this.logger.info({ database: entry.database }, 'DatabaseService: Pool connected.');
      return pool;
    }

    if (lastError === undefined) {
      throw new MssqlMcpError(`The connection pool for database '${entry.database}' was closed.`, ErrorType.CONNECTION_ERROR, undefined, { database: entry.database });
    }
    const wrapped = toMssqlMcpError(lastError, ErrorType.CONNECTION_ERROR, { database: entry.database });
    const cannotOpenDatabase =
      wrapped.sqlErrorNumber === SQL_ERROR_CANNOT_OPEN_DATABASE ||
      (wrapped.sqlErrorNumber === undefined && lastLoginErrorNumbers.includes(SQL_ERROR_CANNOT_OPEN_DATABASE));
    if (cannotOpenDatabase) {
      throw new MssqlMcpError(
        `Cannot open database '${entry.database}': it does not exist, or the login cannot access it.`,
        wrapped.errorType,
        wrapped.originalError,
        { database: entry.database, attempts },
        { code: wrapped.code, sqlErrorNumber: SQL_ERROR_CANNOT_OPEN_DATABASE }
      );
    }
    throw new MssqlMcpError(
      `Failed to connect to SQL Server database '${entry.database}': ${wrapped.message}`,
      wrapped.errorType,
      wrapped.originalError,
      { database: entry.database, attempts },
      { code: wrapped.code, sqlErrorNumber: wrapped.sqlErrorNumber }
    );
  }

  /**
   * Runs `fn` with the database's pool. A pool whose connection was lost is retired, so the
   * next call builds a new one. The failed operation itself is not retried.
   */
  private async withPool<T>(database: string, fn: (pool: sql.ConnectionPool, entry: PoolEntry) => Promise<T>): Promise<T> {
    const entry = this.entryFor(database);
    entry.active++;
    let pool: sql.ConnectionPool | null = null;
    try {
      pool = await this.connectEntry(entry);
      return await fn(pool, entry);
    } catch (error: unknown) {
      if (pool && (classifyError(error, ErrorType.UNKNOWN_ERROR).connectionLost || !pool.connected)) {
        this.retireEntry(entry, 'connection lost');
      }
      throw error;
    } finally {
      entry.active--;
      entry.lastUsed = Date.now();
      if (entry.retired && entry.active === 0) this.closeRetiredEntry(entry);
    }
  }

  /** Stops handing out the entry's pool; it is closed as soon as no operation uses it. */
  private retireEntry(entry: PoolEntry, reason: string): void {
    if (entry.retired) return;
    entry.retired = true;
    if (this.pools.get(entry.key) === entry) this.pools.delete(entry.key);
    this.logger.info({ database: entry.database, reason }, 'DatabaseService: Retiring connection pool.');
    if (entry.active === 0) this.closeRetiredEntry(entry);
  }

  private closeRetiredEntry(entry: PoolEntry): void {
    const pool = entry.pool;
    entry.pool = null;
    if (pool) void this.closePoolQuietly(pool, entry.database);
  }

  private async closePoolQuietly(pool: sql.ConnectionPool, database: string): Promise<void> {
    try {
      await pool.close();
    } catch (err: unknown) {
      this.logger.warn({ err, database }, 'DatabaseService: Error closing connection pool.');
    }
  }

  private ensureIdleSweep(): void {
    if (this.sweepTimer || this.closed) return;
    this.sweepTimer = setInterval(() => this.sweepIdlePools(), POOL_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  private sweepIdlePools(): void {
    const now = Date.now();
    for (const entry of [...this.pools.values()]) {
      if (entry.key !== this.defaultKey && entry.active === 0 && !entry.connecting && now - entry.lastUsed > POOL_IDLE_TTL_MS) {
        this.retireEntry(entry, 'idle');
      }
    }
  }

  /** Connects the default database's pool, logging instead of throwing on failure. */
  public async warmUp(): Promise<void> {
    try {
      await this.withPool(this.sqlConfig.database, async () => undefined);
      this.logger.info({ database: this.sqlConfig.database }, 'DatabaseService: Default connection pool is ready.');
    } catch (err: unknown) {
      this.logger.warn(
        { err, database: this.sqlConfig.database },
        'DatabaseService: Could not connect to the default database; tool calls will connect on demand.'
      );
    }
  }

  /** Closes every pool. Later operations fail with a connection error. */
  public async closeAll(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const entries = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(entries.map(async (entry) => {
      entry.retired = true;
      const pool = entry.pool;
      entry.pool = null;
      if (pool) await this.closePoolQuietly(pool, entry.database);
    }));
    this.logger.info('DatabaseService: All connection pools closed.');
  }

  // ---------------------------------------------------------------------------
  // Rollback-only transactions and streaming
  // ---------------------------------------------------------------------------

  /**
   * Run `work` inside a transaction that is always rolled back, whether `work` succeeds,
   * fails with a SQL error, throws, or is cancelled. `work` must not settle while its request
   * is still running, so the rollback never meets a request in progress. If the rollback
   * fails in a way that may leave the transaction open, the connection is closed (which
   * makes SQL Server roll it back) and the pool is retired so the connection is not reused.
   * Rollback failures are logged and never replace the error raised by `work`.
   */
  private async runInRollbackOnlyTransaction<T>(
    pool: sql.ConnectionPool,
    entry: PoolEntry,
    operation: string,
    signal: AbortSignal | undefined,
    work: (request: sql.Request) => Promise<T>
  ): Promise<T> {
    const transaction = new sql.Transaction(pool);
    try {
      await transaction.begin();
      throwIfAborted(signal);
      return await work(new sql.Request(transaction));
    } finally {
      const outcome = await this.rollbackQuietly(transaction, operation);
      if (outcome === 'unsafe') this.retireEntry(entry, 'rollback failed');
    }
  }

  /**
   * Roll back `transaction`, logging instead of throwing on failure.
   * - EABORT: SQL Server already rolled the transaction back (e.g. after a severe or
   *   XACT_ABORT error) and the driver has already released the connection.
   * - ENOTBEGUN: begin() failed before a connection was acquired; nothing to undo.
   * - Error 3903 (no corresponding BEGIN TRANSACTION): the batch itself ended the
   *   transaction. The driver still releases the connection, which has no open
   *   transaction left.
   * - Anything else: the transaction may still be open, so the connection is closed.
   */
  private async rollbackQuietly(transaction: sql.Transaction, operation: string): Promise<RollbackOutcome> {
    const held = (transaction as unknown as { _acquiredConnection?: HeldConnection | null })._acquiredConnection ?? null;
    try {
      await transaction.rollback();
      return 'rolled-back';
    } catch (rollbackError: unknown) {
      const code = (rollbackError as { code?: unknown } | null)?.code;
      const noBeginTran = extractDriverErrorInfo(rollbackError).sqlErrorNumber === SQL_ERROR_NO_CORRESPONDING_BEGIN_TRAN;

      if (code === 'EABORT' || code === 'ENOTBEGUN') {
        this.logger.debug({ code, operation }, 'DatabaseService: Transaction was already ended before rollback.');
        return 'already-ended';
      }
      if (noBeginTran) {
        this.logger.warn({ code, operation }, 'DatabaseService: Transaction was ended by the batch before rollback.');
        return 'already-ended';
      }

      this.logger.error({ err: rollbackError, operation }, 'DatabaseService: Rollback of read-only transaction failed; closing its connection.');
      if (held && typeof held.close === 'function') {
        try {
          held.close();
        } catch (closeError: unknown) {
          this.logger.warn({ err: closeError, operation }, 'DatabaseService: Error closing connection after failed rollback.');
        }
      }
      return 'unsafe';
    }
  }

  /**
   * Runs a request in stream mode with rows as arrays, feeding the pager. When
   * `stopWhenPageFull` is set, the request is cancelled as soon as the pager has seen the
   * first row past the page. Aborting `signal` cancels the request. Settles only after the
   * driver reports the request done, by which point it has released the connection back
   * to the transaction.
   */
  private async runStreamingRequest(
    request: sql.Request,
    pager: RecordsetPager,
    start: (request: sql.Request) => Promise<unknown>,
    options: { stopWhenPageFull: boolean; signal?: AbortSignal }
  ): Promise<StreamOutcome> {
    const { stopWhenPageFull, signal } = options;
    request.stream = true;
    request.arrayRowMode = true;

    let pageFull = false;
    let abortedByClient = false;
    const errors: unknown[] = [];
    let done: { output?: Record<string, unknown>; returnValue?: unknown; rowsAffected?: number[] } | undefined;

    request.on('recordset', (columns: unknown) => pager.startRecordset(columns));
    request.on('row', (row: unknown) => {
      if (pageFull || abortedByClient) return;
      if (pager.addRow(row) && stopWhenPageFull) {
        pageFull = true;
        request.cancel();
      }
    });
    request.on('error', (err: unknown) => errors.push(err));
    request.on('done', (result: typeof done) => { done = result; });

    const onAbort = () => {
      abortedByClient = true;
      request.cancel();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    try {
      // In stream mode this settles after the driver's 'done' event
      await start(request);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (abortedByClient) throw cancelledError();
    const failure = errors.find((err) => !(pageFull && errorCode(err) === 'ECANCEL'));
    if (failure !== undefined) throw failure;

    return {
      output: done?.output ?? {},
      returnValue: done?.returnValue,
      rowsAffected: done?.rowsAffected ?? [],
    };
  }

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------

  public async getSchema(dbIdentifier: string): Promise<TableSchema[]> {
    this.assertDatabaseAllowed(dbIdentifier, 'schema retrieval');

    const cacheKey = databaseNameKey(dbIdentifier);
    const cachedSchema = this.schemaCache.get(cacheKey);
    if (cachedSchema && (Date.now() - cachedSchema.timestamp < this.sqlConfig.schemaCacheTTL)) {
      this.logger.debug({ database: dbIdentifier }, 'DatabaseService: Returning cached schema.');
      return cachedSchema.data;
    }

    try {
      // Catalog-only SELECTs generated here; they need no transaction
      const tables = await this.withPool(dbIdentifier, async (pool) => {
        const result = await pool.request().query(SCHEMA_QUERY);
        const sets = result.recordsets as unknown as [SchemaColumnRow[]?, ForeignKeyRow[]?];
        return buildTableSchemas(sets[0] ?? [], sets[1] ?? []);
      });
      this.schemaCache.set(cacheKey, { timestamp: Date.now(), data: tables });
      return tables;
    } catch (error: unknown) {
      throw toMssqlMcpError(error, ErrorType.SCHEMA_ERROR, { database: dbIdentifier });
    }
  }

  public async executeQuery(
    query: string,
    rawDatabaseArg?: string,
    offset?: number,
    limit?: number,
    options: OperationOptions = {}
  ): Promise<QueryResult> {
    const targetDatabase = rawDatabaseArg || this.sqlConfig.database;
    this.assertDatabaseAllowed(targetDatabase, 'query execution');

    if (!query || query.trim() === '') {
      throw new MssqlMcpError('DatabaseService: Query cannot be empty', ErrorType.VALIDATION_ERROR, undefined, { query });
    }

    // Single read-only SELECT statement only; throws MssqlMcpError otherwise
    validateReadOnlyQuery(query, { allowedDatabases: this.validatorAllowedDatabases });

    const window = resolvePageWindow(offset, limit, this.maxRows);
    const { signal } = options;

    try {
      throwIfAborted(signal);
      return await this.withPool(targetDatabase, (pool, entry) =>
        this.runInRollbackOnlyTransaction(pool, entry, 'executeQuery', signal, async (request) => {
          const pager = new RecordsetPager(window);
          await this.runStreamingRequest(request, pager, (r) => r.query(query), { stopWhenPageFull: true, signal });
          return buildQueryResult(pager, window);
        })
      );
    } catch (error: unknown) {
      throw toMssqlMcpError(error, ErrorType.QUERY_ERROR, { database: targetDatabase, query: querySnippet(query) });
    }
  }

  public async executeStoredProcedure(
    procedure: string,
    parameters: ProcedureParameterInput[] = [],
    rawDatabaseArg?: string,
    options: OperationOptions = {}
  ): Promise<StoredProcedureResult> {
    const targetDatabase = rawDatabaseArg || this.sqlConfig.database;
    this.assertDatabaseAllowed(targetDatabase, 'stored procedure execution');

    const name = requireProcedureName(procedure);

    // Allow-list: only procedures named in SQL_ALLOWED_PROCEDURES may run
    if (!this.allowedProcedureKeys.has(name.key)) {
      throw new MssqlMcpError(
        `DatabaseService: Execution of stored procedure '${procedure}' is not allowed.`,
        ErrorType.PERMISSION_ERROR,
        undefined,
        { procedure }
      );
    }

    const prepared = parameters.map(prepareProcedureParameter);
    const { signal } = options;

    try {
      throwIfAborted(signal);
      return await this.withPool(targetDatabase, (pool, entry) =>
        this.runInRollbackOnlyTransaction(pool, entry, 'executeStoredProcedure', signal, async (request) => {
          for (const param of prepared) {
            if (param.direction === 'out') {
              request.output(param.name, param.sqlType, param.value);
            } else {
              request.input(param.name, param.sqlType, param.value);
            }
          }

          const pager = new RecordsetPager({ offset: 0, limit: this.maxRows }, false);
          const outcome = await this.runStreamingRequest(request, pager, (r) => r.execute(name.canonical), { stopWhenPageFull: false, signal });
          return {
            recordsets: pager.recordsets(),
            outputParameters: formatOutputParameters(outcome.output, prepared.filter((param) => param.direction === 'out')),
            returnValue: outcome.returnValue,
            rowsAffected: outcome.rowsAffected,
          };
        })
      );
    } catch (error: unknown) {
      throw toMssqlMcpError(error, ErrorType.STORED_PROCEDURE_ERROR, { database: targetDatabase, procedure: name.canonical });
    }
  }
}
