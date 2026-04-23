import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { 
  DatabaseService, 
  SqlConfig, 
  QueryResult, 
  StoredProcedureResult 
} from './DatabaseService.js'; // Import DatabaseService, SqlConfig, and result types
import { MssqlMcpError, ErrorType, ErrorDetails } from './errors.js';
import { sqlConfig } from "./config.js";
import type { McpServerWithRegisterTool } from './types.js';
import pino from "pino";

// Define mcpConfig for server name and version
const mcpConfig = {
  name: "mssql-mcp",
  version: "1.0.1"
};

// pino.destination(2) writes to stderr so it doesn't interfere with stdio MCP transport
const logger = (pino as any)({ level: (sqlConfig as SqlConfig).logLevel || 'info' }, pino.destination(2));

// Create an MCP server
const server = new McpServer({
  name: mcpConfig.name,
  version: mcpConfig.version
});

// Cast to access registerTool — the method exists at runtime in SDK v1.23+ but
// the published .d.ts has a deep-inference bug in the deprecated tool() overloads
// that causes TS2589 when any method is called on the typed McpServer instance.
const mcpServer = server as any as McpServerWithRegisterTool;

// Instantiate DatabaseService - will be initialized in main()
let databaseService: DatabaseService;

// Tool parameter schemas
const spParamSchema = z.object({
  name: z.string().describe("Parameter name"),
  type: z.string().describe("SQL parameter type (e.g., 'VarChar', 'Int')"),
  value: z.unknown().optional().describe("Parameter value")
});

const executeQueryParams = {
  query: z.string().describe("SQL query to execute"),
  database: z.string().optional().describe("Target database name")
};

const executeSpParams = {
  procedure: z.string().describe("Stored procedure name to execute"),
  parameters: z.array(spParamSchema).optional().describe("Parameters for the stored procedure"),
  database: z.string().optional().describe("Target database name")
};

// SQL query execution tool
mcpServer.registerTool(
  "execute_query",
  {
    description: "Execute a read-only SQL query against a SQL Server database. Supports SELECT statements only — use execute_stored_procedure for calling stored procedures.",
    inputSchema: executeQueryParams,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  async (args: { query: string; database?: string }, context) => {
    logger.info({ tool: 'execute_query', arguments: args }, 'MCP execute_query tool received request');

    const { query, database: rawDatabaseArg } = args;

    try {
      const result: QueryResult = await databaseService.executeQuery(query, rawDatabaseArg); // USE QueryResult type
      logger.info({ result }, 'Query executed successfully');
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: unknown) {
      
      logger.error({ err: error, query, database: rawDatabaseArg }, 'Error in execute_query tool handler');
      const mcpError = MssqlMcpError.fromError(error, ErrorType.QUERY_ERROR, { tool: 'execute_query', query, database: rawDatabaseArg } as ErrorDetails);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: mcpError.message,
            errorType: mcpError.errorType,
            details: mcpError.details
          }, null, 2)
        }]
      };
    }
  }
);

// Stored procedure execution tool
mcpServer.registerTool(
  "execute_stored_procedure",
  {
    description: "Execute a stored procedure on a SQL Server database",
    inputSchema: executeSpParams,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  async (args: { 
    procedure: string; 
    parameters?: Array<{ name: string; type: string; value?: any }>; 
    database?: string 
  }, context) => {
    const { procedure, parameters = [], database: rawDatabaseArg } = args;

    try {
      const result: StoredProcedureResult = await databaseService.executeStoredProcedure(procedure, parameters, rawDatabaseArg);
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: unknown) {
      logger.error({ err: error, procedure, database: rawDatabaseArg }, 'Error in execute_stored_procedure tool handler');
      const mcpError = MssqlMcpError.fromError(error, ErrorType.STORED_PROCEDURE_ERROR, { tool: 'execute_stored_procedure', procedure, database: rawDatabaseArg } as ErrorDetails);
      return {
        isError: true,
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify({
            error: mcpError.message,
            errorType: mcpError.errorType,
            details: mcpError.details
          }, null, 2)
        }]
      };
    }
  }
);

// Database schema resource
server.resource(
  "schema",
  new ResourceTemplate("schema://{database}", {
    list: async () => {
      const typedConfig = sqlConfig as SqlConfig;
      const databases = typedConfig.allowedDatabases?.length
        ? typedConfig.allowedDatabases
        : [typedConfig.database];
      return {
        resources: databases.map(db => ({
          uri: `schema://${db}`,
          name: `Schema: ${db}`
        }))
      };
    },
    complete: {
      database: async () => {
        const typedConfig = sqlConfig as SqlConfig;
        return typedConfig.allowedDatabases?.length
          ? typedConfig.allowedDatabases
          : [typedConfig.database];
      }
    }
  }),
  async (uri, params: { database?: string | string[] }, context) => {
    const dbParam = params.database;
    const dbIdentifier = Array.isArray(dbParam) ? dbParam[0] || (sqlConfig as SqlConfig).database : (dbParam || (sqlConfig as SqlConfig).database);

    try {
      const tables = await databaseService.getSchema(dbIdentifier);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ tables }, null, 2)
        }]
      };
    } catch (error: unknown) {
      logger.error({ err: error, database: dbIdentifier }, 'Error in schema resource handler');
      const mcpError = MssqlMcpError.fromError(error, ErrorType.SCHEMA_ERROR, { resource: 'schema', database: dbIdentifier } as ErrorDetails);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            error: mcpError.message,
            errorType: mcpError.errorType,
            details: mcpError.details
          }, null, 2)
        }]
      };
    }
  }
);

// Create transport with debug logging
const transport = new StdioServerTransport();

async function cleanup() {
  logger.info('Shutting down server, cleaning up resources...');
  if (databaseService) {
    await databaseService.closePool();
  }
  logger.info('Cleanup complete');
  return true;
}

process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal');
  const cleanupSuccess = await cleanup();
  process.exit(cleanupSuccess ? 0 : 1);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal');
  const cleanupSuccess = await cleanup();
  process.exit(cleanupSuccess ? 0 : 1);
});

async function main() {
  logger.info('Starting MSSQL MCP server...');
  
  const typedSqlConfig: SqlConfig = sqlConfig as SqlConfig;

  logger.info({ 
    server: typedSqlConfig.server, 
    port: typedSqlConfig.port, 
    database: typedSqlConfig.database,
    logLevel: typedSqlConfig.logLevel
  }, 'SQL Server configuration loaded');

  databaseService = new DatabaseService(typedSqlConfig, logger);

  process.on('uncaughtException', (error: Error) => {
    logger.fatal({ err: error }, 'UNCAUGHT EXCEPTION');
    cleanup().finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason: unknown, promise: Promise<any>) => {
    logger.fatal({ reason, promise }, 'UNHANDLED REJECTION');
    cleanup().finally(() => process.exit(1));
  });

  try {
    logger.info('Initializing database connection pool via DatabaseService...');
    const pool = await databaseService.getPool();

    if (pool && pool.connected) {
      logger.info('Successfully established connection pool via DatabaseService.');
      await pool.request().query('SELECT 1 AS initial_connection_test');
      logger.info('Connection pool verified with test query via DatabaseService.');
    } else {
      // This case should ideally not be reached if getPool throws on failure as intended.
      logger.fatal('Critical: Failed to establish connection pool via DatabaseService (pool not connected after getPool resolved).');
      await cleanup();
      process.exit(1);
    }
  } catch (error) {
    logger.fatal({ err: error }, 'Critical error during initial pool connection via DatabaseService');
    await cleanup();
    process.exit(1);
  }

  try {
    await server.connect(transport);

    logger.info('MCP server ready');
    logger.info({ tools: ['execute_query', 'execute_stored_procedure'], resources: ['schema://{database}'] }, 'Available MCP tools and resources');
  } catch (error: unknown) {
    logger.fatal({ err: error }, 'Critical: Failed to start MCP server transport');
    await cleanup();
    process.exit(1);
  }
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "Critical: Unhandled error in main function execution");
  await cleanup();
  process.exit(1);
});