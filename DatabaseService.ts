import sql from 'mssql';
import { Logger } from 'pino';
import { MssqlMcpError, ErrorType } from './errors.js';
import nodeParser from 'node-sql-parser';

// Default maximum rows returned per recordset if not configured
const DEFAULT_MAX_ROWS = 1000;

// System stored procedures that are never allowed to be executed
const DENIED_SYSTEM_PROCEDURES: ReadonlySet<string> = new Set([
  'xp_cmdshell',
  'xp_regread',
  'xp_regwrite',
  'xp_regdelete',
  'xp_regenumvalues',
  'xp_servicecontrol',
  'xp_availablemedia',
  'xp_dirtree',
  'xp_enumdsn',
  'xp_enumerrorlogs',
  'xp_fixeddrives',
  'xp_loginconfig',
  'xp_makecab',
  'xp_msver',
  'xp_sprintf',
  'xp_sscanf',
  'sp_configure',
  'sp_addlogin',
  'sp_droplogin',
  'sp_adduser',
  'sp_dropuser',
  'sp_addrole',
  'sp_droprole',
  'sp_addrolemember',
  'sp_droprolemember',
  'sp_addsrvrolemember',
  'sp_dropsrvrolemember',
  'sp_password',
  'sp_changedbowner',
  'sp_addextendedproc',
  'sp_dropextendedproc',
  'sp_addlinkedserver',
  'sp_droplinkedserver',
  'sp_executesql',
  'sp_oacreate',
  'sp_oamethod',
  'sp_oagetproperty',
  'sp_oadestroy',
  'sp_send_dbmail',
]);

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
  options?: {
    encrypt?: boolean;
    trustServerCertificate?: boolean;
    [key: string]: any;
  };
  pool?: {
    min?: number;
    max?: number;
    idleTimeoutMillis?: number;
    [key: string]: any;
  };
  logLevel?: string;
}

// Type definitions
interface TableSchema {
  schema: string;
  name: string;
  fullName: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    primary: boolean;
  }>;
}

interface SchemaQueryRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  NUMERIC_PRECISION: number | null;
  NUMERIC_SCALE: number | null;
  IS_NULLABLE: 'YES' | 'NO';
  IS_PRIMARY_KEY: 0 | 1;
  ORDINAL_POSITION: number;
}

// Shared interface for a single recordset
export interface Recordset {
  columns: string[];
  rows: any[][];
  recordCount: number;
}

// Interface for executeQuery result
export interface QueryResultSuccess {
  recordsets: Recordset[];
  totalRecordCount: number;
  pagination?: {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
    totalRowsFetched: number;
  };
}
export interface QueryResultMessage {
  message: string;
  recordCount?: 0;
}
export type QueryResult = QueryResultSuccess | QueryResultMessage;

// Interface for executeStoredProcedure result
export interface StoredProcedureResultSuccess {
  recordsets: Recordset[];
  totalRecordCount: number;
  outputParameters?: Record<string, any>;
  returnValue: any;
  rowsAffected?: number[];
}
export interface StoredProcedureResultMessage {
  message: string;
  outputParameters?: Record<string, any>;
  returnValue: any;
  rowsAffected?: number[];
  recordCount?: 0;
}
export type StoredProcedureResult = StoredProcedureResultSuccess | StoredProcedureResultMessage;

export class DatabaseService {
  private pool: sql.ConnectionPool | null = null;
  private connectionPromise: Promise<sql.ConnectionPool> | null = null;
  private isConnecting: boolean = false;
  private schemaCache: Map<string, { timestamp: number; data: TableSchema[] }> = new Map();
  private connectionRetries: number = 0;

  private readonly sqlConfig: SqlConfig;
  private readonly logger: Logger;
  // Normalized allowedDatabases (lowercased, trimmed) for case-insensitive comparison
  private readonly normalizedAllowedDatabases: string[];

  // Map of string type names to mssql.ISqlTypeFactory objects
  private readonly sqlDataTypeMap: Map<string, sql.ISqlTypeFactoryWithNoParams | sql.ISqlTypeFactoryWithLength | sql.ISqlTypeFactoryWithPrecisionScale | sql.ISqlTypeFactoryWithScale | sql.ISqlTypeFactoryWithTvpType> = new Map([
    ['bigint', sql.BigInt],
    ['binary', sql.Binary],
    ['bit', sql.Bit],
    ['char', sql.Char],
    ['date', sql.Date],
    ['datetime', sql.DateTime],
    ['datetime2', sql.DateTime2],
    ['datetimeoffset', sql.DateTimeOffset],
    ['decimal', sql.Decimal],
    ['float', sql.Float],
    ['geography', sql.Geography],
    ['geometry', sql.Geometry],
    ['image', sql.Image],
    ['int', sql.Int],
    ['money', sql.Money],
    ['nchar', sql.NChar],
    ['ntext', sql.NText],
    ['numeric', sql.Numeric],
    ['nvarchar', sql.NVarChar],
    ['real', sql.Real],
    ['smalldatetime', sql.SmallDateTime],
    ['smallint', sql.SmallInt],
    ['smallmoney', sql.SmallMoney],
    ['text', sql.Text],
    ['time', sql.Time],
    ['tinyint', sql.TinyInt],
    ['tvp', sql.TVP],
    ['uniqueidentifier', sql.UniqueIdentifier],
    ['varbinary', sql.VarBinary],
    ['varchar', sql.VarChar],
    ['variant', sql.Variant],
    ['xml', sql.Xml],
    // Common variations
    ['string', sql.NVarChar],
    ['number', sql.Int],
    ['boolean', sql.Bit],
  ]);

  constructor(sqlConfig: SqlConfig, logger: Logger) {
    this.sqlConfig = sqlConfig;
    this.logger = logger;
    // Pre-normalize allowedDatabases once at construction
    this.normalizedAllowedDatabases = (sqlConfig.allowedDatabases || [])
      .map(db => db.trim().toLowerCase())
      .filter(Boolean);
    this.logger.info('DatabaseService instantiated.');
  }

  /**
   * Check if the target database is allowed by the whitelist (case-insensitive, trimmed).
   * Throws PERMISSION_ERROR if not allowed.
   */
  private assertDatabaseAllowed(targetDatabase: string, operation: string): void {
    if (this.normalizedAllowedDatabases.length > 0 && !this.normalizedAllowedDatabases.includes(targetDatabase.toLowerCase().trim())) {
      this.logger.warn(
        { database: targetDatabase, allowed: this.sqlConfig.allowedDatabases },
        `DatabaseService: Access to database '${targetDatabase}' is not allowed for ${operation}.`
      );
      throw new MssqlMcpError(
        `Access to database '${targetDatabase}' is not allowed. Allowed databases: ${(this.sqlConfig.allowedDatabases || []).join(', ')}`,
        ErrorType.PERMISSION_ERROR,
        undefined,
        { database: targetDatabase, allowed: this.sqlConfig.allowedDatabases }
      );
    }
  }

  /**
   * Validate a database name for safe use in identifiers.
   */
  private assertValidDatabaseName(dbName: string): void {
    if (!/^[a-zA-Z0-9_\-\s\[\]]+$/.test(dbName)) {
      throw new MssqlMcpError(
        `DatabaseService: Invalid database name format: ${dbName}`,
        ErrorType.VALIDATION_ERROR,
        undefined,
        { database: dbName }
      );
    }
  }

  /**
   * Sanitize a database name for use inside square-bracket identifiers.
   */
  private sanitizeDbName(dbName: string): string {
    return dbName.replace(/\]/g, '').replace(/\[/g, '');
  }

  /**
   * Open a dedicated (non-pooled) connection for a specific database.
   * Used when the target database differs from the pool's default to avoid
   * the race condition of issuing USE on a shared pool connection.
   */
  private async openDedicatedConnection(targetDatabase: string): Promise<sql.ConnectionPool> {
    this.assertValidDatabaseName(targetDatabase);
    const sanitized = this.sanitizeDbName(targetDatabase);
    this.logger.info({ database: sanitized }, 'DatabaseService: Opening dedicated connection for cross-database operation.');

    const dedicatedPool = new sql.ConnectionPool({
      ...this.sqlConfig,
      database: sanitized,
      // Dedicated connections use a minimal pool — one connection, short-lived
      pool: { min: 0, max: 1, idleTimeoutMillis: 5000 },
    });

    await dedicatedPool.connect();
    return dedicatedPool;
  }

  /**
   * Get a connection pool for the given target database.
   * Returns the shared pool if targeting the default database, or opens a
   * dedicated connection for cross-database operations.
   * Callers MUST call `maybeCloseDedicated` on the returned pool when done.
   */
  private async getConnectionForDatabase(targetDatabase: string): Promise<sql.ConnectionPool> {
    if (targetDatabase === this.sqlConfig.database) {
      return this.getPool();
    }
    return this.openDedicatedConnection(targetDatabase);
  }

  /**
   * Close a dedicated connection pool (no-op if it's the shared pool).
   */
  private async maybeCloseDedicated(pool: sql.ConnectionPool): Promise<void> {
    if (pool !== this.pool) {
      try {
        await pool.close();
      } catch (err) {
        this.logger.error({ err }, 'DatabaseService: Error closing dedicated connection.');
      }
    }
  }

  /**
   * Parse raw recordsets from mssql into our Recordset[] format.
   */
  private parseRecordsets(rawRecordsets: unknown): { recordsets: Recordset[]; totalRecordCount: number } {
    const cast = rawRecordsets as Array<sql.IRecordSet<any>> | undefined;
    const allRecordsets: Recordset[] = [];
    let totalRecordCount = 0;

    if (cast && cast.length > 0) {
      for (const rs of cast) {
        if (rs && rs.length > 0) {
          allRecordsets.push({
            columns: Object.keys(rs[0]),
            rows: rs.map((row: any) => Object.values(row)),
            recordCount: rs.length
          });
          totalRecordCount += rs.length;
        } else if (rs) {
          let columnNames: string[] = [];
          if ((rs as any).columns) {
            const colArray = Object.values((rs as any).columns) as Array<{ index: number; name: string }>;
            colArray.sort((a, b) => a.index - b.index);
            columnNames = colArray.map(c => c.name);
          }
          allRecordsets.push({ columns: columnNames, rows: [], recordCount: 0 });
        }
      }
    }

    return { recordsets: allRecordsets, totalRecordCount };
  }

  /**
   * Shared error handler for operation catch blocks.
   * Classifies the error, attempts pool reconnection on connection errors, and throws MssqlMcpError.
   */
  private async handleOperationError(
    error: unknown,
    operation: string,
    defaultErrorType: ErrorType,
    context: Record<string, any>
  ): Promise<never> {
    this.logger.error({ err: error, ...context }, `DatabaseService: ${operation} error`);

    if (error instanceof MssqlMcpError) {
      throw error;
    }

    if (error instanceof Error) {
      let errorType = defaultErrorType;
      const msg = error.message.toLowerCase();

      if (msg.includes('invalid sql syntax')) errorType = ErrorType.SQL_PARSER_ERROR;
      else if (msg.includes('permission')) errorType = ErrorType.PERMISSION_ERROR;
      else if (msg.includes('constraint')) errorType = ErrorType.VALIDATION_ERROR;
      else if (msg.includes('timeout')) errorType = ErrorType.CONNECTION_TIMEOUT;
      else if (msg.includes('connect') || msg.includes('failed to connect') || (error as any).code === 'ESOCKET') {
        errorType = ErrorType.CONNECTION_ERROR;
        this.logger.warn({ ...context, originalError: error.message }, `DatabaseService: Connection error during ${operation}. Attempting to re-establish pool.`);
        await this.closePool();
        try {
          await this.getPool();
          this.logger.info(context, `DatabaseService: Pool re-established after connection error during ${operation}.`);
        } catch (reconnectError: unknown) {
          this.logger.error({ err: reconnectError, ...context, originalError: error.message }, `DatabaseService: Failed to re-establish pool after ${operation} connection error.`);
          throw new MssqlMcpError(
            `Operation '${operation}' failed due to a connection error, and reconnection also failed.`,
            ErrorType.CONNECTION_ERROR,
            reconnectError instanceof Error ? reconnectError : new Error(String(reconnectError)),
            { ...context, operation, originalErrorMsg: error.message }
          );
        }
      }

      throw MssqlMcpError.fromError(error, errorType, context);
    }

    throw MssqlMcpError.fromError(error, ErrorType.UNKNOWN_ERROR, context);
  }

  private mapStringToSqlType(typeName: string): sql.ISqlTypeFactoryWithNoParams | sql.ISqlTypeFactoryWithLength | sql.ISqlTypeFactoryWithPrecisionScale | sql.ISqlTypeFactoryWithScale | sql.ISqlTypeFactoryWithTvpType {
    const normalizedTypeName = typeName.toLowerCase().trim();
    const sqlTypeFactory = this.sqlDataTypeMap.get(normalizedTypeName);

    if (!sqlTypeFactory) {
      this.logger.warn({ typeName, normalizedTypeName }, `DatabaseService: SQL data type '${typeName}' is not explicitly mapped. Defaulting to NVarChar.`);
      return sql.NVarChar;
    }
    return sqlTypeFactory;
  }

  public async closePool(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.close();
        this.logger.info('DatabaseService: SQL connection pool closed.');
      } catch (err) {
        this.logger.error({ err }, 'DatabaseService: Error closing SQL connection pool.');
      } finally {
        this.pool = null;
        this.connectionPromise = null;
      }
    }
  }

  private async initPool(timeoutMs?: number): Promise<sql.ConnectionPool> {
    // If a connection attempt is already in progress, return the existing promise.
    if (this.connectionPromise) {
      this.logger.info('DatabaseService: Connection attempt already in progress, returning existing promise.');
      return this.connectionPromise;
    }

    // If there's an existing, connected, and healthy pool, reuse it.
    if (this.pool && this.pool.connected) {
      try {
        await this.pool.request().query('SELECT 1 AS test_connection');
        this.logger.info('DatabaseService: Reusing existing and connected pool.');
        return this.pool;
      } catch (e) {
        this.logger.warn({ err: e }, 'DatabaseService: Existing pool failed test, re-initializing.');
        await this.closePool();
      }
    }

    if (!this.sqlConfig.password) {
      this.logger.error('DatabaseService: SQL Server password not provided. Set SQL_PASSWORD environment variable.');
      throw new MssqlMcpError('SQL Server password not provided.', ErrorType.VALIDATION_ERROR, undefined, { missingVariable: 'SQL_PASSWORD' });
    }

    this.connectionPromise = (async () => {
      let poolInstance: sql.ConnectionPool | null = null;
      try {
        this.logger.info({ server: this.sqlConfig.server, port: this.sqlConfig.port, user: this.sqlConfig.user }, 'DatabaseService: Creating new SQL connection pool.');

        poolInstance = new sql.ConnectionPool({
          ...this.sqlConfig,
          requestTimeout: timeoutMs || this.sqlConfig.requestTimeout || 30000,
          connectionTimeout: timeoutMs || this.sqlConfig.connectionTimeout || 30000,
        });

        poolInstance.on('error', async (err: Error) => {
          this.logger.error({ err }, 'DatabaseService: SQL pool instance error.');
          if (this.pool === poolInstance) {
            await this.closePool();
          } else if (poolInstance) {
            poolInstance.close().catch(closeErr => this.logger.error({ err: closeErr }, 'DatabaseService: Error closing errored non-active pool instance.'));
          }
        });

        // Connect with timeout
        const connectTimeout = this.sqlConfig.connectionTimeout || 30000;
        const connectOperation = poolInstance.connect();
        let timer: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MssqlMcpError(`DatabaseService: Connection attempt timed out after ${connectTimeout}ms`, ErrorType.CONNECTION_TIMEOUT)), connectTimeout);
        });

        try {
          const connectedPool = await Promise.race([connectOperation, timeoutPromise]) as sql.ConnectionPool;
          this.pool = connectedPool;
        } catch (err: unknown) {
          if (poolInstance && typeof poolInstance.close === 'function' && poolInstance !== this.pool) {
            poolInstance.close().catch(closeErr => this.logger.error({ err: closeErr }, 'DatabaseService: Error closing pool instance on timeout/connect error.'));
          }
          if (err instanceof MssqlMcpError) throw err;
          throw MssqlMcpError.fromError(err, ErrorType.CONNECTION_ERROR, { customMessage: 'DatabaseService: Failed to connect to SQL Server.' });
        } finally {
          if (timer) clearTimeout(timer);
        }

        if (!this.pool) {
          throw MssqlMcpError.fromError('DatabaseService: Pool was not assigned after connect.', ErrorType.UNKNOWN_ERROR, { function: 'initPool' });
        }

        this.logger.info('DatabaseService: SQL connection pool connected successfully.');
        this.connectionRetries = 0;
        return this.pool;
      } catch (error: unknown) {
        this.logger.error({ err: error }, 'DatabaseService: SQL Server connection error.');

        if (poolInstance && poolInstance !== this.pool) {
          try {
            await poolInstance.close();
            this.logger.info('DatabaseService: Cleaned up intermediate poolInstance after error.');
          } catch (closeError) {
            this.logger.error({ err: closeError }, 'DatabaseService: Error closing intermediate poolInstance after connection error.');
          }
        }

        if (this.pool) {
          await this.closePool();
        } else {
          this.connectionPromise = null;
        }

        if (error instanceof MssqlMcpError) throw error;
        throw MssqlMcpError.fromError(error, ErrorType.CONNECTION_ERROR, { customMessage: 'DatabaseService: SQL Server connection failed.' });
      } finally {
        // Nullify connectionPromise once settled so future callers don't re-await a stale promise
        if (this.pool !== poolInstance) {
          this.connectionPromise = null;
        }
      }
    })();
    return this.connectionPromise;
  }

  public async getPool(currentAttempt = 0): Promise<sql.ConnectionPool> {
    if (this.pool && this.pool.connected) {
      return this.pool;
    }

    // If a connection is actively being established by another call, wait for it.
    if (this.isConnecting && this.connectionPromise) {
      this.logger.info('[DatabaseService] getPool: Connection attempt already in progress, awaiting existing promise.');
      try {
        const poolFromPromise = await this.connectionPromise;
        if (this.pool && this.pool.connected && this.pool === poolFromPromise) {
          return this.pool;
        }
        this.logger.warn('[DatabaseService] getPool: Watched connectionPromise resolved but pool state is unexpected. Retrying.');
      } catch (error) {
        this.logger.warn({ err: error }, '[DatabaseService] getPool: Watched connectionPromise failed. Retrying.');
        this.isConnecting = false;
      }
    }

    if (this.isConnecting) {
      this.logger.info('[DatabaseService] getPool: isConnecting is true but no active promise, brief wait and retry.');
      await new Promise(resolve => setTimeout(resolve, this.sqlConfig.initialRetryDelay / 2 || 500));
      return this.getPool(currentAttempt);
    }

    this.isConnecting = true;

    this.logger.info({ attempt: currentAttempt + 1, maxRetries: this.sqlConfig.maxRetries }, `[DatabaseService] getPool: Attempting to establish connection (Attempt ${currentAttempt + 1}).`);

    try {
      await this.initPool();

      if (!this.pool || !this.pool.connected) {
        throw MssqlMcpError.fromError('DatabaseService: Pool not connected after initPool resolved without error.', ErrorType.CONNECTION_ERROR);
      }

      this.logger.info('[DatabaseService] getPool: Successfully connected and pool is initialized.');
      this.isConnecting = false;
      this.connectionRetries = 0;
      return this.pool;
    } catch (error: unknown) {
      this.isConnecting = false;

      const mssqlError = MssqlMcpError.fromError(error, ErrorType.CONNECTION_ERROR);
      this.logger.error(
        { err: mssqlError, attempt: currentAttempt + 1 },
        `[DatabaseService] getPool: Error establishing connection pool (Attempt ${currentAttempt + 1})`
      );

      // maxRetries means total attempts (not retries-after-first)
      if (currentAttempt + 1 < this.sqlConfig.maxRetries) {
        const delay = Math.min(
          this.sqlConfig.initialRetryDelay * Math.pow(2, currentAttempt) + Math.random() * 1000,
          this.sqlConfig.maxRetryDelay
        );
        this.logger.info({ delayMs: delay }, '[DatabaseService] getPool: Retrying connection...');
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.getPool(currentAttempt + 1);
      } else {
        this.logger.error({ attempts: this.sqlConfig.maxRetries }, '[DatabaseService] getPool: Max connection attempts reached.');
        throw new MssqlMcpError(
          `DatabaseService: Failed to connect to database after ${this.sqlConfig.maxRetries} attempts. Last error: ${mssqlError.message}`,
          ErrorType.CONNECTION_ERROR,
          mssqlError.originalError,
          { attempts: this.sqlConfig.maxRetries, ...mssqlError.details }
        );
      }
    }
  }

  public async getSchema(dbIdentifier: string): Promise<TableSchema[]> {
    this.assertDatabaseAllowed(dbIdentifier, 'schema retrieval');

    this.logger.info({ database: dbIdentifier }, `DatabaseService: Fetching schema for database: ${dbIdentifier}`);

    // Check cache first
    const cachedSchema = this.schemaCache.get(dbIdentifier);
    if (cachedSchema && (Date.now() - cachedSchema.timestamp < this.sqlConfig.schemaCacheTTL)) {
      this.logger.info({ database: dbIdentifier }, 'DatabaseService: Returning cached schema.');
      return cachedSchema.data;
    }
    this.logger.info({ database: dbIdentifier }, 'DatabaseService: No valid cache found, fetching from DB.');

    const dbPool = await this.getConnectionForDatabase(dbIdentifier);

    try {
      const schemaResult = await dbPool.request().query<SchemaQueryRow>(`
        SELECT 
            t.TABLE_SCHEMA, 
            t.TABLE_NAME,
            c.COLUMN_NAME, 
            c.DATA_TYPE,
            c.CHARACTER_MAXIMUM_LENGTH,
            c.NUMERIC_PRECISION,
            c.NUMERIC_SCALE,
            c.IS_NULLABLE,
            CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY,
            c.ORDINAL_POSITION
        FROM 
            INFORMATION_SCHEMA.TABLES t
        INNER JOIN 
            INFORMATION_SCHEMA.COLUMNS c ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        LEFT JOIN (
            SELECT 
                ku.TABLE_SCHEMA,
                ku.TABLE_NAME,
                ku.COLUMN_NAME
            FROM 
                INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc
            INNER JOIN 
                INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS ku 
                ON tc.CONSTRAINT_TYPE = 'PRIMARY KEY' 
                AND tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
        ) pk ON c.TABLE_SCHEMA = pk.TABLE_SCHEMA AND c.TABLE_NAME = pk.TABLE_NAME AND c.COLUMN_NAME = pk.COLUMN_NAME
        WHERE 
            t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY 
            t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION;
      `);

      const tablesMap: Map<string, TableSchema> = new Map();

      for (const row of schemaResult.recordset) {
        const tableName = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
        if (!tablesMap.has(tableName)) {
          tablesMap.set(tableName, {
            schema: row.TABLE_SCHEMA,
            name: row.TABLE_NAME,
            fullName: tableName,
            columns: []
          });
        }

        let columnType = row.DATA_TYPE;
        if (row.CHARACTER_MAXIMUM_LENGTH) {
          columnType += `(${row.CHARACTER_MAXIMUM_LENGTH})`;
        } else if (row.NUMERIC_PRECISION !== null && row.NUMERIC_SCALE !== null) {
          columnType += `(${row.NUMERIC_PRECISION},${row.NUMERIC_SCALE})`;
        }

        tablesMap.get(tableName)!.columns.push({
          name: row.COLUMN_NAME,
          type: columnType,
          nullable: row.IS_NULLABLE === 'YES',
          primary: row.IS_PRIMARY_KEY === 1
        });
      }

      const tables: TableSchema[] = Array.from(tablesMap.values());

      this.schemaCache.set(dbIdentifier, { timestamp: Date.now(), data: tables });
      this.logger.info({ database: dbIdentifier }, 'DatabaseService: Schema cached.');

      return tables;
    } catch (error: unknown) {
      return await this.handleOperationError(error, 'getSchema', ErrorType.SCHEMA_ERROR, { database: dbIdentifier });
    } finally {
      await this.maybeCloseDedicated(dbPool);
    }
  }

  public async executeQuery(query: string, rawDatabaseArg?: string, offset?: number, limit?: number): Promise<QueryResult> {
    const targetDatabase = rawDatabaseArg || this.sqlConfig.database;
    this.assertDatabaseAllowed(targetDatabase, 'query execution');

    this.logger.info({ database: targetDatabase }, 'DatabaseService: Executing query.');

    if (!query || query.trim() === '') {
      throw new MssqlMcpError('DatabaseService: Query cannot be empty', ErrorType.VALIDATION_ERROR, undefined, { query });
    }

    // Parse and validate — SELECT only
    const parser = new nodeParser.Parser();
    let ast;
    try {
      ast = parser.astify(query, { database: 'transactsql' });
    } catch (parseError: unknown) {
      this.logger.error({ err: parseError }, 'DatabaseService: SQL parsing error');
      const originalError = parseError instanceof Error ? parseError : undefined;
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      throw new MssqlMcpError(`DatabaseService: Invalid SQL syntax: ${message}`, ErrorType.SQL_PARSER_ERROR, originalError, { query: query.substring(0, 200) });
    }

    const queries = Array.isArray(ast) ? ast : [ast];
    for (const q of queries) {
      if (q.type !== 'select') {
        throw new MssqlMcpError(
          'DatabaseService: Only SELECT queries are allowed. DELETE, INSERT, UPDATE, and other DML/DDL operations are not permitted.',
          ErrorType.VALIDATION_ERROR,
          undefined,
          { queryType: q.type }
        );
      }
    }

    // Defense-in-depth: word-boundary checks for dangerous keywords
    // Uses \b to avoid false positives on column names like 'crisp_products' or 'exec_date'
    const dangerousPatterns = /\b(exec\s|execute\s|reconfigure|waitfor\s+delay)\b/i;
    if (dangerousPatterns.test(query)) {
      throw new MssqlMcpError(
        'DatabaseService: Potentially unsafe query detected. Use the execute_stored_procedure tool for stored procedures.',
        ErrorType.VALIDATION_ERROR,
        undefined,
        { query: query.substring(0, 200) }
      );
    }

    const dbPool = await this.getConnectionForDatabase(targetDatabase);

    try {
      const result = await dbPool.request().query(query);

      const { recordsets, totalRecordCount } = this.parseRecordsets(result.recordsets);

      // Apply pagination: offset skips rows, limit caps how many are returned
      const effectiveLimit = limit ?? (this.sqlConfig.maxRows ?? DEFAULT_MAX_ROWS);
      const effectiveOffset = offset ?? 0;

      const paginatedRecordsets = recordsets.map(rs => {
        const sliceStart = Math.min(effectiveOffset, rs.rows.length);
        const sliceEnd = Math.min(sliceStart + effectiveLimit, rs.rows.length);
        const slicedRows = rs.rows.slice(sliceStart, sliceEnd);
        return { ...rs, rows: slicedRows, recordCount: slicedRows.length };
      });

      const returnedRows = paginatedRecordsets.reduce((sum, rs) => sum + rs.recordCount, 0);
      const hasMore = totalRecordCount > effectiveOffset + effectiveLimit;

      if (paginatedRecordsets.length > 0) {
        return {
          recordsets: paginatedRecordsets,
          totalRecordCount,
          pagination: {
            offset: effectiveOffset,
            limit: effectiveLimit,
            hasMore,
            ...(hasMore ? { nextOffset: effectiveOffset + effectiveLimit } : {}),
            totalRowsFetched: returnedRows
          }
        };
      } else {
        return {
          recordsets: [{ columns: [], rows: [], recordCount: 0 }],
          totalRecordCount: 0
        };
      }
    } catch (error: unknown) {
      return await this.handleOperationError(error, 'executeQuery', ErrorType.QUERY_ERROR, { query: query.length > 100 ? query.substring(0, 100) + '...' : query });
    } finally {
      await this.maybeCloseDedicated(dbPool);
    }
  }

  public async executeStoredProcedure(procedure: string, parameters: Array<{ name: string; type: string; value?: any }> = [], rawDatabaseArg?: string): Promise<StoredProcedureResult> {
    const targetDatabase = rawDatabaseArg || this.sqlConfig.database;
    this.assertDatabaseAllowed(targetDatabase, 'stored procedure execution');

    this.logger.info({ database: targetDatabase, procedure, parametersCount: parameters.length }, `DatabaseService: Executing stored procedure ${procedure}`);

    if (!procedure || procedure.trim() === '') {
      throw new MssqlMcpError('DatabaseService: Procedure name cannot be empty', ErrorType.VALIDATION_ERROR, undefined, { procedure });
    }

    if (!/^([a-zA-Z0-9_]+\.)?[a-zA-Z0-9_]+$/.test(procedure)) {
      throw new MssqlMcpError('DatabaseService: Invalid procedure name format. Use [schema].[procedure_name]', ErrorType.VALIDATION_ERROR, undefined, { procedure });
    }

    // Check against deny-list of dangerous system procedures
    const normalizedProcName = procedure.toLowerCase().split('.').pop()!;
    if (DENIED_SYSTEM_PROCEDURES.has(normalizedProcName)) {
      throw new MssqlMcpError(
        `DatabaseService: Execution of system procedure '${procedure}' is not allowed.`,
        ErrorType.PERMISSION_ERROR,
        undefined,
        { procedure }
      );
    }

    const dbPool = await this.getConnectionForDatabase(targetDatabase);

    try {
      const request = dbPool.request();

      for (const param of parameters) {
        if (!param.name || !param.type) {
          throw new MssqlMcpError('DatabaseService: Each parameter must have a name and type', ErrorType.VALIDATION_ERROR, undefined, { parameter: param });
        }

        const paramName = param.name.startsWith('@') ? param.name : `@${param.name}`;
        const sqlTypeFactory = this.mapStringToSqlType(param.type);
        request.input(paramName.replace('@', ''), sqlTypeFactory, param.value);
      }

      const result = await request.execute(procedure);

      const { recordsets, totalRecordCount } = this.parseRecordsets(result.recordsets);

      if (recordsets.length > 0 && totalRecordCount > 0) {
        return {
          recordsets,
          totalRecordCount,
          outputParameters: result.output,
          returnValue: result.returnValue,
          rowsAffected: result.rowsAffected
        };
      } else {
        return {
          message: 'Stored procedure executed successfully, but returned no records',
          outputParameters: result.output,
          returnValue: result.returnValue,
          rowsAffected: result.rowsAffected,
          recordCount: 0
        };
      }
    } catch (error: unknown) {
      return await this.handleOperationError(error, 'executeStoredProcedure', ErrorType.STORED_PROCEDURE_ERROR, { procedure });
    } finally {
      await this.maybeCloseDedicated(dbPool);
    }
  }
}
