import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DatabaseService,
  type QueryResult,
  type StoredProcedureResult,
} from './DatabaseService.js';
import { ErrorType, toClientError, toMssqlMcpError } from './errors.js';
import { SQL_PARAMETER_TYPES } from './procedures.js';
import { toCompactJson } from './resultFormat.js';
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { pino } from "pino";

/**
 * Reads the version from the nearest package.json above this module, which is the project
 * root both when run from source and from dist/.
 */
function readPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const version: unknown = (JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }).version;
      return typeof version === 'string' ? version : '0.0.0';
    }
    const parent = dirname(dir);
    if (parent === dir) return '0.0.0';
    dir = parent;
  }
}

/** Loads the configuration, or reports what is invalid on stderr and exits. */
function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const mcpConfig = {
  name: "mssql-mcp",
  version: readPackageVersion()
};

// Force exit if shutdown has not finished after this long
const SHUTDOWN_TIMEOUT_MS = 5000;

// Error types caused by the request itself rather than by the server or database; logged at warn
const CLIENT_ERROR_TYPES: ReadonlySet<ErrorType> = new Set([
  ErrorType.VALIDATION_ERROR,
  ErrorType.PERMISSION_ERROR,
  ErrorType.SQL_PARSER_ERROR,
  ErrorType.CANCELLED,
]);

const appConfig = readConfig();

// pino.destination(2) writes to stderr so it doesn't interfere with stdio MCP transport
const logger = pino({ level: appConfig.logLevel }, pino.destination(2));

// Create an MCP server
const server = new McpServer({
  name: mcpConfig.name,
  version: mcpConfig.version
});

// Creating the service does not connect; pools connect on first use
const databaseService = new DatabaseService(appConfig, logger);
const maxRows = databaseService.maxRowsPerRecordset;

function rowCountOf(recordsets: Array<{ recordCount: number }>): number {
  return recordsets.reduce((sum, rs) => sum + rs.recordCount, 0);
}

/** Logs a failed tool call once and builds the client error payload. */
function toolErrorResult(tool: string, error: unknown, defaultType: ErrorType, logContext: Record<string, unknown>, startedAt: number) {
  const mcpError = toMssqlMcpError(error, defaultType);
  const level = CLIENT_ERROR_TYPES.has(mcpError.errorType) ? 'warn' : 'error';
  logger[level]({ tool, err: mcpError, errorType: mcpError.errorType, durationMs: Date.now() - startedAt, ...logContext }, `${tool} failed`);
  return {
    isError: true,
    content: [{ type: "text" as const, text: toCompactJson(toClientError(mcpError)) }]
  };
}

// Tool parameter schemas
const spParamSchema = z.object({
  name: z.string().describe("Parameter name, with or without a leading @"),
  type: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.enum(SQL_PARAMETER_TYPES)
  ).describe("SQL Server parameter type (case-insensitive), e.g. 'nvarchar', 'int', 'decimal'"),
  value: z.unknown().optional().describe("Parameter value (initial value for an output parameter)"),
  direction: z.enum(['in', 'out']).optional().describe("'in' (default) for an input parameter, 'out' for an output parameter"),
  length: z.union([z.number().int().min(1), z.literal('max')]).optional().describe("Length for binary, char, nchar, varbinary, varchar and nvarchar; 'max' for varbinary, varchar and nvarchar"),
  precision: z.number().int().min(1).max(38).optional().describe("Precision for decimal and numeric (default 18)"),
  scale: z.number().int().min(0).max(38).optional().describe("Scale for decimal and numeric (default 0), or fractional-second scale 0-7 for time, datetime2 and datetimeoffset (default 7)")
});

const DATE_TIME_OUTPUT_DESCRIPTION = "Date and time values are returned as their SQL text, with as many fractional-second digits as the column's scale: date '2026-10-01', time '13:45:00.1234567', datetime2 '2026-10-01T12:34:56.1234567' and datetime '2026-10-01T12:34:56.123' (wall-clock values with no time zone), smalldatetime '2026-10-01T12:34:00', and datetimeoffset " +
  (databaseService.dateTimeOffsetMode === 'offset-preserved'
    ? "'2026-10-01T12:34:56.1234567+05:30', which keeps its original offset."
    : "converted to UTC, e.g. '2026-10-01T07:04:56.1234567+00:00' (the original offset is not available).") +
  " A date/time value inside a sql_variant is returned as date-and-time text with trailing fractional zeros removed (a date as '2026-10-01T00:00:00', a time as '1970-01-01T13:45:00'), " +
  (databaseService.dateTimeOffsetMode === 'offset-preserved'
    ? "and a datetimeoffset inside a sql_variant as its local time plus its original offset, e.g. '2026-10-01T07:18:20+05:30'."
    : "and a datetimeoffset inside a sql_variant as its UTC time with no offset marker, e.g. '2026-10-01T01:48:20', indistinguishable from a datetime2.");

const executeQueryParams = {
  query: z.string().describe("T-SQL query to execute: a single SELECT statement"),
  database: z.string().optional().describe("Target database name"),
  offset: z.number().int().min(0).optional().describe("Number of rows to skip (for pagination). Defaults to 0."),
  limit: z.number().int().min(1).optional().describe(`Maximum number of rows to return per result set (for pagination). Defaults to ${maxRows}; larger values are capped at ${maxRows}.`)
};

const executeSpParams = {
  procedure: z.string().describe("Schema-qualified stored procedure name, e.g. dbo.GetOrders or [dbo].[GetOrders]"),
  parameters: z.array(spParamSchema).optional().describe("Parameters for the stored procedure"),
  database: z.string().optional().describe("Target database name")
};

// Stored procedure execution tool: registered only when SQL_ALLOWED_PROCEDURES lists at least one valid procedure
const storedProcedureToolEnabled = databaseService.allowedProcedureCount > 0;

// SQL query execution tool
server.registerTool(
  "execute_query",
  {
    description: `Execute a read-only T-SQL query against a SQL Server database. Supports a single SELECT statement only (a WITH ... SELECT is fine)${storedProcedureToolEnabled ? ' — use execute_stored_procedure for calling stored procedures' : ''}. Results are returned in \`recordsets\`; each recordset contains \`columns\` and positional \`rows\`, and each row is an array whose values align by index with \`columns\`. Multiple SQL result sets are returned as multiple entries in \`recordsets\`. Binary values are returned as hex strings (truncated after 64 bytes) and bigint values as strings. ${DATE_TIME_OUTPUT_DESCRIPTION} Results are paginated: use offset and limit parameters to page through large result sets; at most ${maxRows} rows are returned per result set. Each recordset carries \`hasMore\` (and \`nextOffset\` when true), and \`pagination\` summarises the page (offset, limit, hasMore, nextOffset, returnedRowCount). Each page re-runs the query, so add an ORDER BY for stable pages.`,
    inputSchema: executeQueryParams,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  async ({ query, database: rawDatabaseArg, offset, limit }, extra) => {
    const startedAt = Date.now();
    const database = rawDatabaseArg || appConfig.database;
    logger.debug({ tool: 'execute_query', database, query, offset, limit }, 'execute_query received');

    try {
      const result: QueryResult = await databaseService.executeQuery(query, rawDatabaseArg, offset, limit, { signal: extra.signal });
      logger.info({ tool: 'execute_query', database, rowCount: rowCountOf(result.recordsets), hasMore: result.pagination.hasMore, durationMs: Date.now() - startedAt }, 'execute_query completed');
      if (logger.isLevelEnabled('debug')) logger.debug({ tool: 'execute_query', result }, 'execute_query result');
      return {
        content: [{ type: "text" as const, text: toCompactJson(result) }]
      };
    } catch (error: unknown) {
      return toolErrorResult('execute_query', error, ErrorType.QUERY_ERROR, { database, query }, startedAt);
    }
  }
);

if (!storedProcedureToolEnabled) {
  logger.info('SQL_ALLOWED_PROCEDURES has no valid entries; execute_stored_procedure tool is not registered.');
} else {
  server.registerTool(
    "execute_stored_procedure",
    {
      description: `Execute a stored procedure on a SQL Server (T-SQL) database. Only schema-qualified procedures on the server's allow-list can be run; any other name is rejected with a permission error. Each call runs inside a transaction that is rolled back when the call ends, so changes are discarded unless the procedure commits on its own. Parameters take a SQL Server type, optional length/precision/scale, and direction 'in' or 'out'; output parameter values are returned in \`outputParameters\`. Tabular results are returned in \`recordsets\`; each recordset contains \`columns\` and positional \`rows\`, and each row is an array whose values align by index with \`columns\`. Multiple result sets are returned as multiple entries in \`recordsets\`. ${DATE_TIME_OUTPUT_DESCRIPTION} This applies to output parameters too. Results are not paged: at most ${maxRows} rows are returned per result set, and \`hasMore\` marks a result set that was cut off.`,
      inputSchema: executeSpParams,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ procedure, parameters = [], database: rawDatabaseArg }, extra) => {
      const startedAt = Date.now();
      const database = rawDatabaseArg || appConfig.database;
      logger.debug({ tool: 'execute_stored_procedure', database, procedure, parameters }, 'execute_stored_procedure received');

      try {
        const result: StoredProcedureResult = await databaseService.executeStoredProcedure(procedure, parameters, rawDatabaseArg, { signal: extra.signal });
        logger.info({ tool: 'execute_stored_procedure', database, procedure, rowCount: rowCountOf(result.recordsets), durationMs: Date.now() - startedAt }, 'execute_stored_procedure completed');
        if (logger.isLevelEnabled('debug')) logger.debug({ tool: 'execute_stored_procedure', result }, 'execute_stored_procedure result');
        return {
          content: [{ type: "text" as const, text: toCompactJson(result) }]
        };
      } catch (error: unknown) {
        return toolErrorResult('execute_stored_procedure', error, ErrorType.STORED_PROCEDURE_ERROR, { database, procedure }, startedAt);
      }
    }
  );
}

// Databases the schema resource lists and completes: the whitelist, or the default database without one
const schemaDatabases = (): string[] =>
  appConfig.allowedDatabases.length ? appConfig.allowedDatabases : [appConfig.database];

// Database schema resource
server.registerResource(
  "schema",
  new ResourceTemplate("schema://{database}", {
    list: async () => ({
      resources: schemaDatabases().map(db => ({
        uri: `schema://${db}`,
        name: `Schema: ${db}`
      }))
    }),
    complete: {
      database: async () => schemaDatabases()
    }
  }),
  {},
  async (uri, params) => {
    const dbParam = params.database;
    const dbIdentifier = Array.isArray(dbParam) ? dbParam[0] || appConfig.database : (dbParam || appConfig.database);
    const startedAt = Date.now();

    try {
      const tables = await databaseService.getSchema(dbIdentifier);
      logger.info({ resource: 'schema', database: dbIdentifier, tableCount: tables.length, durationMs: Date.now() - startedAt }, 'schema resource read');
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toCompactJson({ tables })
        }]
      };
    } catch (error: unknown) {
      const mcpError = toMssqlMcpError(error, ErrorType.SCHEMA_ERROR);
      const clientError = CLIENT_ERROR_TYPES.has(mcpError.errorType);
      logger[clientError ? 'warn' : 'error']({ resource: 'schema', err: mcpError, database: dbIdentifier, durationMs: Date.now() - startedAt }, 'schema resource failed');
      throw new McpError(clientError ? ErrorCode.InvalidParams : ErrorCode.InternalError, mcpError.message, toClientError(mcpError));
    }
  }
);

const transport = new StdioServerTransport();

let shutdownPromise: Promise<void> | null = null;

/** Stops the server once: closes the MCP server and every pool, then exits. */
function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  // Assigned before any cleanup runs: closing the server re-enters shutdown through onclose
  let finished!: () => void;
  shutdownPromise = new Promise<void>((resolve) => { finished = resolve; });
  logger.info({ reason }, 'Shutting down server, cleaning up resources...');

  const forceExit = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown did not finish in time; forcing exit.');
    process.exit(exitCode || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  void (async () => {
    try {
      await server.close();
    } catch (err: unknown) {
      logger.warn({ err }, 'Error closing MCP server');
    }
    try {
      await databaseService.closeAll();
    } catch (err: unknown) {
      logger.warn({ err }, 'Error closing database pools');
    }
    logger.info('Cleanup complete');
  })().finally(() => {
    clearTimeout(forceExit);
    finished();
    process.exit(exitCode);
  });
  return shutdownPromise;
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.stdin.on('end', () => { void shutdown('stdin closed'); });
process.on('uncaughtException', (error: Error) => {
  logger.fatal({ err: error }, 'UNCAUGHT EXCEPTION');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal({ reason }, 'UNHANDLED REJECTION');
  void shutdown('unhandledRejection', 1);
});

async function main() {
  logger.info('Starting MSSQL MCP server...');
  logger.info({
    server: appConfig.server,
    port: appConfig.port,
    database: appConfig.database,
    logLevel: appConfig.logLevel
  }, 'SQL Server configuration loaded');

  server.server.onclose = () => { void shutdown('transport closed'); };

  try {
    await server.connect(transport);
  } catch (error: unknown) {
    logger.fatal({ err: error }, 'Critical: Failed to start MCP server transport');
    await shutdown('transport failed', 1);
    return;
  }

  const tools = storedProcedureToolEnabled ? ['execute_query', 'execute_stored_procedure'] : ['execute_query'];
  logger.info({ tools, resources: ['schema://{database}'] }, 'MCP server ready');

  // Connect the default pool in the background; tool calls connect on demand if this fails
  void databaseService.warmUp();
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "Critical: Unhandled error in main function execution");
  await shutdown('main failed', 1);
});
