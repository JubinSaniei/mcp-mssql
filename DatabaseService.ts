import sql from 'mssql';
import { AbortController } from 'abort-controller';
import { Logger } from 'pino';
import { MssqlMcpError, ErrorType } from './errors.js';
import nodeParser from 'node-sql-parser';

// Define SqlConfig interface
export interface SqlConfig {
  server: string;
  port: number;
  user: string;
  password?: string; // Password might not be present if auth fails early
  database: string;
  requestTimeout?: number;
  connectionTimeout?: number;
  maxRetries: number;
  initialRetryDelay: number;
  maxRetryDelay: number;
  schemaCacheTTL: number;
  allowedDatabases?: string[];
  options?: {
    encrypt?: boolean;
    trustServerCertificate?: boolean;
    [key: string]: any; // Allow other mssql options
  };
  pool?: {
    min?: number;
    max?: number;
    idleTimeoutMillis?: number;
    [key: string]: any; // Allow other mssql pool options
  };
  logLevel?: string; // Added logLevel
  // Add any other properties from config.js that are passed and used
}

// Type definitions (can be moved to a shared types file later if needed)
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

// NEW: Interface for executeQuery result
export interface QueryResultSuccess {
  columns: string[];
  rows: any[][]; // Values within rows can be of any SQL type
  recordCount: number;
}
export interface QueryResultMessage {
  message: string;
  recordCount?: 0; // Explicitly state no records for message-only responses
}
export type QueryResult = QueryResultSuccess | QueryResultMessage;

// NEW: Interface for executeStoredProcedure result
export interface StoredProcedureResultSuccess {
  columns?: string[]; // Optional as some SPs might not return recordsets
  rows?: any[][];    // Optional
  recordCount?: number; // Optional
  outputParameters?: Record<string, any>; // SP output parameters
  returnValue: any; // SP return value
  rowsAffected?: number[]; // rowsAffected is an array
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
  private abortController: AbortController | null = null;
  private schemaCache: Map<string, { timestamp: number; data: TableSchema[] }> = new Map();
  private connectionRetries: number = 0;

  private readonly sqlConfig: SqlConfig; // Updated type
  private readonly logger: Logger;

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
    // Common variations (lowercase)
    ['string', sql.NVarChar], // Defaulting string to NVarChar
    ['number', sql.Int],      // Defaulting number to Int
    ['boolean', sql.Bit],     // Defaulting boolean to Bit
  ]);

  constructor(sqlConfig: SqlConfig, logger: Logger) { // Updated type
    this.sqlConfig = sqlConfig;
    this.logger = logger;
    this.logger.info('DatabaseService instantiated.');
  }

  private mapStringToSqlType(typeName: string): sql.ISqlTypeFactoryWithNoParams | sql.ISqlTypeFactoryWithLength | sql.ISqlTypeFactoryWithPrecisionScale | sql.ISqlTypeFactoryWithScale | sql.ISqlTypeFactoryWithTvpType {
    const normalizedTypeName = typeName.toLowerCase().trim();
    const sqlTypeFactory = this.sqlDataTypeMap.get(normalizedTypeName);

    if (!sqlTypeFactory) {
      this.logger.warn({ typeName, normalizedTypeName }, `DatabaseService: SQL data type '${typeName}' is not explicitly mapped. Defaulting to NVarChar. Known types: ${Array.from(this.sqlDataTypeMap.keys()).join(', ')}`);
      return sql.NVarChar; // Default to NVarChar for unknown types
    }
    return sqlTypeFactory;
  }

  public async closePool(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.pool) {
      try {
        await this.pool.close();
        this.logger.info(`[${new Date().toISOString()}] DatabaseService: SQL connection pool closed.`);
      } catch (err) {
        this.logger.error(`[${new Date().toISOString()}] DatabaseService: Error closing SQL connection pool:`, err);
      } finally {
        this.pool = null;
        this.connectionPromise = null; // Reset connection promise on close
      }
    }
  }

  private async initPool(timeoutMs?: number): Promise<sql.ConnectionPool> {
    // If a connection attempt is already in progress and the signal matches, return the existing promise.
    if (this.connectionPromise && this.abortController && !this.abortController.signal.aborted) {
      this.logger.info(`[${new Date().toISOString()}] DatabaseService: Connection attempt already in progress, returning existing promise.`);
      return this.connectionPromise;
    }

    // If there's an existing, connected, and healthy pool, reuse it.
    if (this.pool && this.pool.connected) {
      try {
        await this.pool.request().query('SELECT 1 AS test_connection');
        this.logger.info(`[${new Date().toISOString()}] DatabaseService: Reusing existing and connected pool.`);
        return this.pool;
      } catch (e) {
        this.logger.warn(`[${new Date().toISOString()}] DatabaseService: Existing pool failed test, re-initializing.`, e);
        // Close the existing pool before creating a new one.
        await this.closePool();
      }
    }

    if (!this.sqlConfig.password) {
      this.logger.error('DatabaseService: SQL Server password not provided. Set SQL_PASSWORD environment variable.');
      throw new MssqlMcpError('SQL Server password not provided.', ErrorType.VALIDATION_ERROR, undefined, { missingVariable: 'SQL_PASSWORD' });
    }

    // Create a new AbortController for this connection attempt.
    if (this.abortController && !this.abortController.signal.aborted) {
      this.logger.warn(`[${new Date().toISOString()}] DatabaseService: Previous AbortController was not aborted. Aborting now.`);
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.connectionPromise = (async () => {
      let poolInstance: sql.ConnectionPool | null = null;
      try {
        this.logger.info(`[${new Date().toISOString()}] DatabaseService: Creating new SQL connection pool...`);
        this.logger.info(`DatabaseService: Connecting to SQL Server ${this.sqlConfig.server}:${this.sqlConfig.port} with user ${this.sqlConfig.user}`);

        poolInstance = new sql.ConnectionPool({
          ...this.sqlConfig,
          requestTimeout: timeoutMs || this.sqlConfig.requestTimeout || 30000,
          connectionTimeout: timeoutMs || this.sqlConfig.connectionTimeout || 30000,
        });

        poolInstance.on('error', async (err: Error) => {
          this.logger.error(`[${new Date().toISOString()}] DatabaseService: SQL pool instance error:`, err);
          if (this.pool === poolInstance) {
            await this.closePool();
          } else if (poolInstance) {
            poolInstance.close().catch(closeErr => this.logger.error(`[${new Date().toISOString()}] DatabaseService: Error closing errored non-active pool instance:`, closeErr));
          }
        });

        if (signal.aborted) {
          if (poolInstance) {
            await poolInstance.close().catch(e => this.logger.error(`Error closing poolInstance on pre-connect abort: ${e}`));
          }
          throw MssqlMcpError.fromError("DatabaseService: Connection attempt aborted before start.", ErrorType.CONNECTION_ERROR, { timing: 'before_start' });
        }

        const connectWithTimeout = async () => {
          if (!poolInstance) {
            throw MssqlMcpError.fromError("DatabaseService: Pool instance is not initialized internally.", ErrorType.UNKNOWN_ERROR, { function: 'connectWithTimeout' });
          }
          const connectOperation = poolInstance.connect();
          const timeout = this.sqlConfig.connectionTimeout || 30000;

          const timeoutPromise = new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new MssqlMcpError(`DatabaseService: Connection attempt timed out after ${timeout}ms`, ErrorType.CONNECTION_TIMEOUT)), timeout);
            if (signal) {
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(MssqlMcpError.fromError("DatabaseService: Connection attempt aborted during timeout wait.", ErrorType.CONNECTION_ERROR, { timing: 'timeout_wait' }));
              });
            }
          });

          try {
            const connectedPool = await Promise.race([connectOperation, timeoutPromise]) as sql.ConnectionPool;

            if (signal.aborted) {
              if (connectedPool && typeof connectedPool.close === 'function') {
                await connectedPool.close();
              }
              throw MssqlMcpError.fromError("DatabaseService: Connection attempt aborted after successful connect, before assignment.", ErrorType.CONNECTION_ERROR, { timing: 'after_connect_pre_assign' });
            }
            this.pool = connectedPool;

          } catch (err: unknown) {
            if (poolInstance && typeof poolInstance.close === 'function' && poolInstance !== this.pool) {
              poolInstance.close().catch(closeErr => this.logger.error("DatabaseService: Error closing pool instance on timeout/connect error:", closeErr));
            }
            if (err instanceof MssqlMcpError) throw err;
            throw MssqlMcpError.fromError(err, ErrorType.CONNECTION_ERROR, { customMessage: 'DatabaseService: Failed to connect to SQL Server.' });
          }

          if (signal.aborted) {
            if (this.pool && typeof this.pool.close === 'function') {
              const tempPool = this.pool;
              this.pool = null;
              await tempPool.close();
            }
            throw MssqlMcpError.fromError("DatabaseService: Connection attempt aborted after assignment.", ErrorType.CONNECTION_ERROR, { timing: 'after_assignment' });
          }
        };

        await connectWithTimeout();

        if (!this.pool) {
          throw MssqlMcpError.fromError("DatabaseService: Pool was not assigned after connect.", ErrorType.UNKNOWN_ERROR, { function: 'initPool' });
        }

        this.logger.info(`[${new Date().toISOString()}] DatabaseService: SQL connection pool connected successfully.`);
        this.connectionRetries = 0;
        return this.pool;
      } catch (error: unknown) {
        this.logger.error(`[${new Date().toISOString()}] DatabaseService: SQL Server connection error: `, error);

        if (poolInstance && poolInstance !== this.pool) {
          try {
            await poolInstance.close();
            this.logger.info(`[${new Date().toISOString()}] DatabaseService: Cleaned up intermediate poolInstance after error.`);
          } catch (closeError) {
            this.logger.error(`[${new Date().toISOString()}] DatabaseService: Error closing intermediate poolInstance after connection error: `, closeError);
          }
        }

        if (this.pool) {
          await this.closePool();
        } else {
          this.connectionPromise = null;
        }

        if (this.abortController && this.abortController.signal === signal) {
          this.abortController.abort();
          this.abortController = null;
        }

        if (error instanceof MssqlMcpError) {
          throw error;
        }
        throw MssqlMcpError.fromError(error, ErrorType.CONNECTION_ERROR, { customMessage: 'DatabaseService: SQL Server connection failed.' });
      } finally {
        if (this.pool !== poolInstance) {
          if (this.connectionPromise && (await this.connectionPromise.catch(() => null)) !== this.pool) {
            this.connectionPromise = null;
          }
        }
      }
    })();
    return this.connectionPromise;
  }

  public async getPool(currentAttempt = 0): Promise<sql.ConnectionPool> { // Renamed attempt for clarity
    if (this.pool && this.pool.connected) {
      // Perform a quick health check if deemed necessary, e.g., if some time has passed.
      // For now, assume if connected, it's good.
      return this.pool;
    }

    // If a connection is actively being established by another call, wait for it.
    if (this.isConnecting && this.connectionPromise) {
      this.logger.info("[DatabaseService] getPool: Connection attempt already in progress, awaiting existing promise.");
      try {
        // Await the ongoing connection promise
        const poolFromPromise = await this.connectionPromise;
        // If successful, this.pool should be set. Verify and return.
        if (this.pool && this.pool.connected && this.pool === poolFromPromise) {
          this.logger.info("[DatabaseService] getPool: Watched connectionPromise succeeded.");
          return this.pool;
        }
        // If the promise resolved but this.pool is not what we expect, something is off.
        // This might indicate a race condition or an unexpected state. Fall through to retry.
        this.logger.warn("[DatabaseService] getPool: Watched connectionPromise resolved but pool state is unexpected. Retrying.");
      } catch (error) {
        // The awaited connectionPromise failed. Log it and fall through to retry.
        this.logger.warn({ err: error }, "[DatabaseService] getPool: Watched connectionPromise failed. Retrying.");
        // Ensure isConnecting is false so this call can become the primary connector if needed.
        this.isConnecting = false; 
        // connectionPromise should be nullified by the initPool that failed.
      }
      // Fall through to a new attempt if the watched promise didn't yield a valid pool.
    }
    
    // Prevent concurrent initializations from this point forward for this specific call stack.
    if (this.isConnecting) {
        // This case implies that this.connectionPromise was null when checked above, 
        // but isConnecting was true. This could be a very brief race condition.
        // Wait a bit and re-evaluate.
        this.logger.info("[DatabaseService] getPool: isConnecting is true but no active promise, brief wait and retry.");
        await new Promise(resolve => setTimeout(resolve, this.sqlConfig.initialRetryDelay / 2 || 500));
        return this.getPool(currentAttempt); // Re-enter the logic
    }

    this.isConnecting = true;
    // this.connectionRetries should be managed by the entity performing retries, which is this function.
    // It should not be confused with a global retry counter if initPool can be called from elsewhere.
    // For this refactor, getPool is the sole manager of retries for establishing the initial pool.

    this.logger.info({ attempt: currentAttempt + 1, maxRetries: this.sqlConfig.maxRetries }, `[DatabaseService] getPool: Attempting to establish connection (Attempt ${currentAttempt + 1}).`);

    try {
      // initPool is now simplified to attempt a single connection. 
      // It will create and manage its own AbortController for that attempt.
      // It will also set this.pool and this.connectionPromise.
      const pool = await this.initPool(); // initPool now handles setting this.pool and its own promise lifecycle.
      
      // After initPool resolves, this.pool should be connected.
      if (!this.pool || !this.pool.connected) {
         // This case should ideally be handled within initPool, which should throw if it can't connect.
         this.logger.error("[DatabaseService] getPool: initPool resolved but pool is not connected. This indicates an issue in initPool logic.");
         throw MssqlMcpError.fromError("DatabaseService: Pool not connected after initPool resolved without error.", ErrorType.CONNECTION_ERROR);
      }
      
      this.logger.info("[DatabaseService] getPool: Successfully connected and pool is initialized.");
      this.isConnecting = false; // Release the lock
      this.connectionRetries = 0; // Reset retries specific to getPool's loop upon success.
      return this.pool;
    } catch (error: unknown) {
      // initPool failed. isConnecting should be released.
      this.isConnecting = false;
      // connectionPromise should have been nullified by the failed initPool.

      const mssqlError = MssqlMcpError.fromError(error, ErrorType.CONNECTION_ERROR);
      this.logger.error(
          { err: mssqlError, attempt: currentAttempt + 1 },
          `[DatabaseService] getPool: Error establishing connection pool (Attempt ${currentAttempt + 1})`
      );

      // Use currentAttempt for retry logic, not this.connectionRetries directly here as it might be shared.
      if (currentAttempt < this.sqlConfig.maxRetries -1) { // -1 because currentAttempt is 0-indexed
        const delay = Math.min(
          this.sqlConfig.initialRetryDelay * Math.pow(2, currentAttempt) + Math.random() * 1000, // Jitter
          this.sqlConfig.maxRetryDelay
        );
        this.logger.info(`[DatabaseService] getPool: Retrying connection in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.getPool(currentAttempt + 1); // Increment attempt for the next retry.
      } else {
        this.logger.error({ attempts: this.sqlConfig.maxRetries }, "[DatabaseService] getPool: Max connection retries reached.");
        throw new MssqlMcpError(
          `DatabaseService: Failed to connect to database after ${this.sqlConfig.maxRetries} attempts. Last error: ${mssqlError.message}`,
          ErrorType.CONNECTION_ERROR,
          mssqlError.originalError,
          { attempts: this.sqlConfig.maxRetries, ...mssqlError.details }
        );
      }
    }
  }

  // Data Operation Methods will go here
  public async getSchema(dbIdentifier: string): Promise<TableSchema[]> {
    // Check against allowedDatabases whitelist
    if (this.sqlConfig.allowedDatabases && this.sqlConfig.allowedDatabases.length > 0 && !this.sqlConfig.allowedDatabases.includes(dbIdentifier)) {
      this.logger.warn(
        { database: dbIdentifier, allowed: this.sqlConfig.allowedDatabases },
        `DatabaseService: Access to schema for database '${dbIdentifier}' is not allowed.`
      );
      throw new MssqlMcpError(
        `Access to schema for database '${dbIdentifier}' is not allowed. Allowed databases: ${this.sqlConfig.allowedDatabases.join(', ')}`,
        ErrorType.PERMISSION_ERROR,
        undefined,
        { database: dbIdentifier, allowed: this.sqlConfig.allowedDatabases }
      );
    }

    this.logger.info({ database: dbIdentifier }, `DatabaseService: Fetching schema for database: ${dbIdentifier}`);

    // Check cache first
    const cachedSchema = this.schemaCache.get(dbIdentifier);
    if (cachedSchema && (Date.now() - cachedSchema.timestamp < this.sqlConfig.schemaCacheTTL)) { 
      this.logger.info({ database: dbIdentifier }, `[${new Date().toISOString()}] DatabaseService: Returning cached schema for database: ${dbIdentifier}`);
      return cachedSchema.data;
    }
    this.logger.info({ database: dbIdentifier }, `[${new Date().toISOString()}] DatabaseService: No valid cache found for schema: ${dbIdentifier}, fetching from DB.`);

    const currentPool = await this.getPool(); // Use class method
    // No need to check if currentPool is null, getPool() throws if it can't connect

    try {
      if (dbIdentifier !== this.sqlConfig.database) {
        if (!/^[a-zA-Z0-9_\-\s\[\]]+$/.test(dbIdentifier)) {
          const err = new MssqlMcpError(
            `DatabaseService: Invalid database name format for schema: ${dbIdentifier}`,
            ErrorType.VALIDATION_ERROR,
            undefined,
            { database: dbIdentifier }
          );
          this.logger.error({ err, database: dbIdentifier }, "DatabaseService: Invalid database name for schema");
          throw err;
        }
        this.logger.info({ database: dbIdentifier }, `DatabaseService: Switching context to database: ${dbIdentifier} for schema retrieval.`);
        await currentPool.request().batch('USE [' + dbIdentifier.replace(/\]/g, '').replace(/\[/g, '') + ']');
      }

      const schemaResult = await currentPool.request().query<SchemaQueryRow>(`
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
      this.logger.info({ database: dbIdentifier }, `[${new Date().toISOString()}] DatabaseService: Schema for database ${dbIdentifier} cached.`);

      return tables;
    } catch (error: unknown) {
      this.logger.error({ err: error, database: dbIdentifier }, 'DatabaseService: Schema query error');
      let mcpError: MssqlMcpError;

      if (error instanceof MssqlMcpError) {
        mcpError = error;
      } else if (error instanceof Error) {
        let errorType = ErrorType.SCHEMA_ERROR;
        const errorMessage = error.message.toLowerCase();

        if (errorMessage.includes('invalid database name format')) {
          errorType = ErrorType.VALIDATION_ERROR;
        } else if (errorMessage.includes('connect') || errorMessage.includes('failed to connect') || (error as any).code === 'ESOCKET') {
          errorType = ErrorType.CONNECTION_ERROR;
          this.logger.warn(`[${new Date().toISOString()}] DatabaseService: Connection error detected during schema fetch for ${dbIdentifier}. Original error: ${error.message}. Attempting to re-establish pool.`);
          await this.closePool(); // Close the potentially broken pool
          try {
            await this.getPool(); 
            this.logger.info(`[${new Date().toISOString()}] DatabaseService: Pool re-established successfully for ${dbIdentifier} after initial connection error during schema fetch. The original operation will still be reported as failed with its initial error.`);
          } catch (reconnectError: unknown) {
            const originalErrorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error({ err: reconnectError, database: dbIdentifier, originalErrorMsg: originalErrorMessage }, `[${new Date().toISOString()}] DatabaseService: Failed to re-establish pool for ${dbIdentifier} after initial connection error during schema fetch.`);
            throw new MssqlMcpError(
              `Operation 'getSchema' for database '${dbIdentifier}' failed due to an initial connection error, and the subsequent attempt to re-establish the connection also failed.`,
              ErrorType.CONNECTION_ERROR,
              reconnectError instanceof Error ? reconnectError : new Error(String(reconnectError)),
              {
                database: dbIdentifier,
                operation: 'getSchema',
                originalErrorMsg: originalErrorMessage,
                details: `Reconnect attempt failed after initial failure of getSchema. Original error: ${originalErrorMessage}. Reconnect error: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`
              }
            );
          }
        }
        mcpError = MssqlMcpError.fromError(error, errorType, { database: dbIdentifier });
      } else {
        mcpError = MssqlMcpError.fromError(error, ErrorType.UNKNOWN_ERROR, { database: dbIdentifier });
      }
      throw mcpError;
    }
  }

  public async executeQuery(query: string, rawDatabaseArg?: string): Promise<QueryResult> { // UPDATED RETURN TYPE
    const targetDatabase = rawDatabaseArg || this.sqlConfig.database;

    if (this.sqlConfig.allowedDatabases && this.sqlConfig.allowedDatabases.length > 0 && !this.sqlConfig.allowedDatabases.includes(targetDatabase)) {
      this.logger.warn(
        { database: targetDatabase, allowed: this.sqlConfig.allowedDatabases, query },
        `DatabaseService: Access to database '${targetDatabase}' is not allowed for query execution.`
      );
      throw new MssqlMcpError(
        `Access to database '${targetDatabase}' is not allowed. Allowed databases: ${this.sqlConfig.allowedDatabases.join(', ')}`,
        ErrorType.PERMISSION_ERROR,
        undefined,
        { database: targetDatabase, allowed: this.sqlConfig.allowedDatabases }
      );
    }

    this.logger.info({ database: targetDatabase, query }, `DatabaseService: Executing query on ${targetDatabase}`);

    const currentPool = await this.getPool();

    try {
      if (targetDatabase !== this.sqlConfig.database) {
        const dbName = typeof targetDatabase === 'string' ? targetDatabase : String(targetDatabase);
        if (!/^[a-zA-Z0-9_\-\s\[\]]+$/.test(dbName)) {
          throw new MssqlMcpError(
            `DatabaseService: Invalid database name format: ${dbName}`,
            ErrorType.VALIDATION_ERROR,
            undefined,
            { database: dbName }
          );
        }
        this.logger.info({ database: dbName }, `DatabaseService: Switching context to database: ${dbName}`);
        await currentPool.request()
          .batch('USE [' + dbName.replace(/\]/g, '').replace(/\[/g, '') + ']');
      }

      if (!query || query.trim() === '') {
        throw new MssqlMcpError('DatabaseService: Query cannot be empty', ErrorType.VALIDATION_ERROR, undefined, { query });
      }

      const parser = new nodeParser.Parser();
      let ast;
      try {
        ast = parser.astify(query, { database: 'transactsql' });
      } catch (parseError: unknown) {
        this.logger.error({ err: parseError, query }, 'DatabaseService: SQL parsing error');
        const originalError = parseError instanceof Error ? parseError : undefined;
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        throw new MssqlMcpError(`DatabaseService: Invalid SQL syntax: ${message}`, ErrorType.SQL_PARSER_ERROR, originalError, { query });
      }

      const queries = Array.isArray(ast) ? ast : [ast];
      for (const q of queries) {
        if (q.type !== 'select') {
          throw new MssqlMcpError(
            'DatabaseService: Only SELECT queries are allowed. DELETE, INSERT, UPDATE, and other DML/DDL operations are not permitted.',
            ErrorType.VALIDATION_ERROR,
            undefined,
            { query, queryType: q.type }
          );
        }
      }
      
      const lowercaseQuery = query.toLowerCase();
      if (lowercaseQuery.includes('exec ') || 
          lowercaseQuery.includes('execute ') || 
          lowercaseQuery.includes('sp_') || 
          lowercaseQuery.includes('xp_') ||
          lowercaseQuery.includes('reconfigure') ||
          lowercaseQuery.includes('waitfor delay')) {
        throw new MssqlMcpError(
          'DatabaseService: Potentially unsafe query detected. Stored procedures, system procedures, and waitfor delay are not allowed in direct queries. Use the execute_StoredProcedure tool for stored procedures.',
          ErrorType.VALIDATION_ERROR,
          undefined,
          { query }
        );
      }

      const result = await currentPool.request().query(query);

      // The primary recordset is in result.recordset
      // If multiple recordsets, they are in result.recordsets (an array)
      // We will primarily work with the first recordset for this MCP tool.
      const recordset: sql.IRecordSet<any> | undefined = result.recordset;

      if (recordset && recordset.length > 0) {
        // We have records in the first recordset
        return {
            columns: Object.keys(recordset[0]), // Get column names from the first row
            rows: recordset.map(row => Object.values(row)),
            recordCount: recordset.length
        };
      } else if (recordset) {
        // Query executed, returned no rows (recordset is empty), but we might have column metadata
        // from the recordset object itself (recordset.columns)
        let columnNames: string[] = [];
        if (recordset.columns) {
            // recordset.columns is a map-like object: { [colName: string]: { index: number, name: string, ... } }
            // We need to extract names, preferably in order.
            const colArray = Object.values(recordset.columns); // Get array of column metadata objects
            colArray.sort((a, b) => a.index - b.index); // Sort by index to maintain order
            columnNames = colArray.map(c => c.name);
        }
        return {
            columns: columnNames,
            rows: [],
            recordCount: 0
        };
      } else {
        // This case implies no recordset was returned at all (e.g. DDL, or certain types of errors not caught below)
        // For SELECT queries, mssql usually returns an empty recordset if no rows match.
        // If it truly is a successful query with no recordset (unlikely for SELECT), return empty success.
        this.logger.info({ query, result }, "Query executed but returned no primary recordset. Assuming success with no data.");
        return {
            columns: [],
            rows: [],
            recordCount: 0
        };
      }
    } catch (error: unknown) {
      this.logger.error({ err: error, query }, 'DatabaseService: SQL query error');
      let mcpError: MssqlMcpError;

      if (error instanceof MssqlMcpError) {
        mcpError = error;
      } else if (error instanceof Error) {
        let errorType = ErrorType.QUERY_ERROR;
        const errorMessage = error.message.toLowerCase();

        if (errorMessage.includes('invalid sql syntax')) errorType = ErrorType.SQL_PARSER_ERROR;
        else if (errorMessage.includes('permission')) errorType = ErrorType.PERMISSION_ERROR;
        else if (errorMessage.includes('constraint')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('timeout')) errorType = ErrorType.CONNECTION_TIMEOUT;
        else if (errorMessage.includes('only select queries are allowed')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('invalid database name format')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('query cannot be empty')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('potentially unsafe query detected')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('connect') || errorMessage.includes('failed to connect') || (error as any).code === 'ESOCKET') {
          errorType = ErrorType.CONNECTION_ERROR;
          this.logger.warn(`[${new Date().toISOString()}] DatabaseService: Connection error detected during query for ${rawDatabaseArg || this.sqlConfig.database}. Original error: ${error.message}. Attempting to re-establish pool.`);
          await this.closePool(); // Close the potentially broken pool
          try {
            await this.getPool(); 
            this.logger.info(`[${new Date().toISOString()}] DatabaseService: Pool re-established successfully for ${rawDatabaseArg || this.sqlConfig.database} after initial connection error during query. The original operation will still be reported as failed with its initial error.`);
          } catch (reconnectError: unknown) {
            const originalErrorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error({ err: reconnectError, database: rawDatabaseArg || this.sqlConfig.database, query, originalErrorMsg: originalErrorMessage }, `[${new Date().toISOString()}] DatabaseService: Failed to re-establish pool for ${rawDatabaseArg || this.sqlConfig.database} after initial connection error during query.`);
            throw new MssqlMcpError(
              `Operation 'executeQuery' for database '${rawDatabaseArg || this.sqlConfig.database}' failed due to an initial connection error, and the subsequent attempt to re-establish the connection also failed.`,
              ErrorType.CONNECTION_ERROR,
              reconnectError instanceof Error ? reconnectError : new Error(String(reconnectError)),
              {
                database: rawDatabaseArg || this.sqlConfig.database,
                operation: 'executeQuery',
                query: query.length > 100 ? query.substring(0, 100) + '...' : query,
                originalErrorMsg: originalErrorMessage,
                details: `Reconnect attempt failed after initial failure of executeQuery. Original error: ${originalErrorMessage}. Reconnect error: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`
              }
            );
          }
        }
        mcpError = MssqlMcpError.fromError(error, errorType, { query: query.length > 100 ? query.substring(0, 100) + '...' : query });
      } else {
        mcpError = MssqlMcpError.fromError(error, ErrorType.UNKNOWN_ERROR, { query: query.length > 100 ? query.substring(0, 100) + '...' : query });
      }
      throw mcpError;
    }
  }

  public async executeStoredProcedure(procedure: string, parameters: Array<{ name: string; type: string; value?: any }> = [], rawDatabaseArg?: string): Promise<StoredProcedureResult> {
    const targetDatabase = rawDatabaseArg || this.sqlConfig.database;

    if (this.sqlConfig.allowedDatabases && this.sqlConfig.allowedDatabases.length > 0 && !this.sqlConfig.allowedDatabases.includes(targetDatabase)) {
      this.logger.warn(
        { database: targetDatabase, allowed: this.sqlConfig.allowedDatabases, procedure },
        `DatabaseService: Access to database '${targetDatabase}' is not allowed for stored procedure execution.`
      );
      throw new MssqlMcpError(
        `Access to database '${targetDatabase}' is not allowed for stored procedure execution. Allowed databases: ${this.sqlConfig.allowedDatabases.join(', ')}`,
        ErrorType.PERMISSION_ERROR,
        undefined,
        { database: targetDatabase, allowed: this.sqlConfig.allowedDatabases, procedure }
      );
    }

    this.logger.info({ database: targetDatabase, procedure, parametersCount: parameters.length }, `DatabaseService: Executing stored procedure ${procedure} on ${targetDatabase}`);

    const currentPool = await this.getPool();

    try {
      if (targetDatabase !== this.sqlConfig.database) {
        const dbName = typeof targetDatabase === 'string' ? targetDatabase : String(targetDatabase);
        if (!/^[a-zA-Z0-9_\-\s\[\]]+$/.test(dbName)) {
          throw new MssqlMcpError(
            `DatabaseService: Invalid database name format: ${dbName}`,
            ErrorType.VALIDATION_ERROR,
            undefined,
            { database: dbName }
          );
        }
        this.logger.info({ database: dbName }, `DatabaseService: Switching context to database: ${dbName} for stored procedure.`);
        await currentPool.request()
          .input('db_name_param', sql.NVarChar, dbName) // Parameterize database name for USE statement
          .batch('USE [' + dbName.replace(/\]/g, '').replace(/\[/g, '') + ']');
      }

      if (!procedure || procedure.trim() === '') {
        throw new MssqlMcpError('DatabaseService: Procedure name cannot be empty', ErrorType.VALIDATION_ERROR, undefined, { procedure });
      }

      if (!/^([a-zA-Z0-9_]+\.)?[a-zA-Z0-9_]+$/.test(procedure)) {
        throw new MssqlMcpError('DatabaseService: Invalid procedure name format. Use [schema].[procedure_name]', ErrorType.VALIDATION_ERROR, undefined, { procedure });
      }

      const request = currentPool.request();

      for (const param of parameters) {
        if (!param.name || !param.type) {
          throw new MssqlMcpError('DatabaseService: Each parameter must have a name and type', ErrorType.VALIDATION_ERROR, undefined, { parameter: param });
        }

        const paramName = param.name.startsWith('@') ? param.name : `@${param.name}`;
        const sqlTypeFactory = this.mapStringToSqlType(param.type);
        request.input(paramName.replace('@', ''), sqlTypeFactory, param.value);
      }

      const result = await request.execute(procedure);

      if (result.recordset && result.recordset.length > 0) {
        return {
            columns: Object.keys(result.recordset[0]),
            rows: result.recordset.map(row => Object.values(row)),
            recordCount: result.recordset.length,
            outputParameters: result.output,
            returnValue: result.returnValue,
            rowsAffected: result.rowsAffected
        };
      } else {
        return {
            message: "Stored procedure executed successfully, but returned no records",
            outputParameters: result.output,
            returnValue: result.returnValue,
            rowsAffected: result.rowsAffected,
            recordCount: 0
        };
      }
    } catch (error: unknown) {
      this.logger.error({ err: error, procedure }, 'DatabaseService: Stored procedure execution error');
      let mcpError: MssqlMcpError;

      if (error instanceof MssqlMcpError) {
        mcpError = error;
      } else if (error instanceof Error) {
        let errorType = ErrorType.STORED_PROCEDURE_ERROR;
        const errorMessage = error.message.toLowerCase();

        if (errorMessage.includes('syntax error')) errorType = ErrorType.SQL_PARSER_ERROR;
        else if (errorMessage.includes('permission')) errorType = ErrorType.PERMISSION_ERROR;
        else if (errorMessage.includes('constraint')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('timeout')) errorType = ErrorType.CONNECTION_TIMEOUT;
        else if (errorMessage.includes('invalid database name format')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('procedure name cannot be empty')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('invalid procedure name format')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('each parameter must have a name and type')) errorType = ErrorType.VALIDATION_ERROR;
        else if (errorMessage.includes('connect') || errorMessage.includes('failed to connect') || (error as any).code === 'ESOCKET') {
          errorType = ErrorType.CONNECTION_ERROR;
          this.logger.warn(`[${new Date().toISOString()}] DatabaseService: Connection error detected during stored procedure ${procedure} for ${rawDatabaseArg || this.sqlConfig.database}. Original error: ${error.message}. Attempting to re-establish pool.`);
          await this.closePool(); // Close the potentially broken pool
          try {
            await this.getPool(); 
            this.logger.info(`[${new Date().toISOString()}] DatabaseService: Pool re-established successfully for ${rawDatabaseArg || this.sqlConfig.database} after initial connection error during stored procedure ${procedure}. The original operation will still be reported as failed with its initial error.`);
          } catch (reconnectError: unknown) {
            const originalErrorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error({ err: reconnectError, database: rawDatabaseArg || this.sqlConfig.database, procedure, originalErrorMsg: originalErrorMessage }, `[${new Date().toISOString()}] DatabaseService: Failed to re-establish pool for ${rawDatabaseArg || this.sqlConfig.database} after initial connection error during stored procedure ${procedure}.`);
            throw new MssqlMcpError(
              `Operation 'executeStoredProcedure' for database '${rawDatabaseArg || this.sqlConfig.database}' (procedure: ${procedure}) failed due to an initial connection error, and the subsequent attempt to re-establish the connection also failed.`,
              ErrorType.CONNECTION_ERROR,
              reconnectError instanceof Error ? reconnectError : new Error(String(reconnectError)),
              {
                database: rawDatabaseArg || this.sqlConfig.database,
                operation: 'executeStoredProcedure',
                procedure,
                originalErrorMsg: originalErrorMessage,
                details: `Reconnect attempt failed after initial failure of executeStoredProcedure. Original error: ${originalErrorMessage}. Reconnect error: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`
              }
            );
          }
        }
        mcpError = MssqlMcpError.fromError(error, errorType, { procedure });
      } else {
        mcpError = MssqlMcpError.fromError(error, ErrorType.UNKNOWN_ERROR, { procedure });
      }
      throw mcpError;
    }
  }

  // Utility methods (e.g., for database switching) can also be added
}
