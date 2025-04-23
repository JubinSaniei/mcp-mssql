import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import sql from 'mssql';
import { sqlConfig, mcpConfig } from './config.js';

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

// Initialize SQL connection settings
let connectionRetries = 0;
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds
const CONNECTION_TIMEOUT = 300000; // 5 minutes

// Session-based connection management
interface SessionConnection {
  pool: sql.ConnectionPool;
  lastUsed: number;
}
const sessionPools = new Map<string, SessionConnection>();

// Default session ID to use when none is provided
// This ensures we maintain a single persistent connection
const DEFAULT_SESSION_ID = 'default-mssql-session';

// Variable to track the last time we pinged the connection to keep it alive
let lastConnectionKeepAliveTime = Date.now();
const KEEP_ALIVE_INTERVAL = 60000; // 1 minute

// Function to keep the default session connection alive
async function keepDefaultSessionAlive(): Promise<void> {
  const now = Date.now();
  // Only run keep-alive if it's been more than the interval since last check
  if (now - lastConnectionKeepAliveTime > KEEP_ALIVE_INTERVAL) {
    lastConnectionKeepAliveTime = now;
    
    // Get the default session connection
    const sessionConnection = sessionPools.get(DEFAULT_SESSION_ID);
    if (sessionConnection) {
      try {
        // Run a simple query to keep the connection alive
        console.log(`[${new Date().toISOString()}] Running keep-alive query for default session`);
        await sessionConnection.pool.request().query('SELECT 1 AS keep_alive');
        console.log(`[${new Date().toISOString()}] Keep-alive successful for default session`);
        
        // Update the last used time
        sessionConnection.lastUsed = now;
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Keep-alive query failed for default session:`, err);
        // If the query failed, the connection is likely dead
        // Remove it from the pool so a new one will be created on next request
        sessionPools.delete(DEFAULT_SESSION_ID);
        
        // Try to reconnect immediately
        try {
          console.log(`[${new Date().toISOString()}] Attempting to reconnect default session after keep-alive failure`);
          await initSqlPool(10000, DEFAULT_SESSION_ID);
        } catch (reconnectErr) {
          console.error(`[${new Date().toISOString()}] Failed to reconnect default session:`, reconnectErr);
        }
      }
    } else {
      // No default session exists, create one
      console.log(`[${new Date().toISOString()}] No default session found during keep-alive, creating one`);
      try {
        await initSqlPool(10000, DEFAULT_SESSION_ID);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to create default session during keep-alive:`, err);
      }
    }
  }
}

// Initialize the SQL pool for a specific session or the default pool
async function initSqlPool(timeoutMs = 10000, sessionId?: string) {
  // Check if password is provided
  if (!sqlConfig.password) {
    console.error('SQL Server password not provided. Set SQL_PASSWORD environment variable.');
    return false;
  }
  
  try {
    // Use default session ID if none provided to ensure consistency
    const effectiveSessionId = sessionId || DEFAULT_SESSION_ID;
    
    // Check if we already have a session pool for this session ID
    const sessionConnection = sessionPools.get(effectiveSessionId);
    if (sessionConnection) {
      try {
        // Test existing connection with a simple query to verify it's still valid
        await sessionConnection.pool.request().query('SELECT 1 AS test');
        console.log(`Reusing existing connection for session ${effectiveSessionId}`);
        sessionConnection.lastUsed = Date.now();
        return true;
      } catch (err) {
        console.log(`Existing connection for session ${effectiveSessionId} failed test: ${err}`);
        // Connection is no longer valid, close it and create a new one
        try {
          await sessionConnection.pool.close();
        } catch (closeErr) {
          console.error(`Error closing session pool for ${effectiveSessionId}:`, closeErr);
        }
        sessionPools.delete(effectiveSessionId);
      }
    }
    
    // Create a new connection for this session
    console.log(`Creating new connection for session ${effectiveSessionId}`);
    
    console.log(`Connecting to SQL Server ${sqlConfig.server}:${sqlConfig.port} with user ${sqlConfig.user} for session ${effectiveSessionId}`);
    
    // Create a promise that resolves when connected or rejects after timeout
    const connectionPromise = sql.connect(sqlConfig);
    
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<sql.ConnectionPool>((_, reject) => {
      setTimeout(() => reject(new Error(`Connection timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    
    // Race the connection against the timeout
    const newPool = await Promise.race([connectionPromise, timeoutPromise]);
    
    // Reset retry counter on successful connection
    connectionRetries = 0;
    
    // Add event handler for connection errors
    newPool.on('error', async (err: Error) => {
      console.error(`SQL pool connection error for session ${effectiveSessionId}:`, err);
      if (connectionRetries < MAX_RETRIES) {
        connectionRetries++;
        console.log(`Attempting to reconnect (${connectionRetries}/${MAX_RETRIES})...`);
        
        // We need to recreate the pool object in case of error
        try {
          if (sessionPools.has(effectiveSessionId)) {
            await sessionPools.get(effectiveSessionId)?.pool.close();
            sessionPools.delete(effectiveSessionId);
          }
        } catch (closeError) {
          console.error(`Error closing pool for session ${effectiveSessionId}:`, closeError);
        }
        
        // Set a timeout before attempting reconnection
        setTimeout(async () => {
          // Reconnect using the same sessionId
          await initSqlPool(timeoutMs, effectiveSessionId);
        }, RETRY_DELAY);
      } else {
        console.error(`Maximum reconnection attempts (${MAX_RETRIES}) reached. Please check your connection settings.`);
      }
    });
    
    // Verify connection with a simple query
    await newPool.request().query('SELECT 1 AS test');
    
    // Store the pool in the session pools map
    sessionPools.set(effectiveSessionId, { pool: newPool, lastUsed: Date.now() });
    console.log(`Created new connection for session ${effectiveSessionId}`);
    
    console.log(`Connected to SQL Server successfully for session ${effectiveSessionId}`);
    return true;
  } catch (error: unknown) {
    console.error(`SQL Server connection error for session ${sessionId || DEFAULT_SESSION_ID}:`, error);
    sessionPools.delete(sessionId || DEFAULT_SESSION_ID);
    return false;
  }
}

// Get the default connection pool
async function getConnectionPool(): Promise<sql.ConnectionPool | null> {
  // Run the keep-alive for the default session
  await keepDefaultSessionAlive();
  
  // Clean up any expired sessions (except the default one)
  cleanupExpiredConnections();
  
  // Check if we have a default session connection
  const sessionConnection = sessionPools.get(DEFAULT_SESSION_ID);
  if (sessionConnection) {
    // Update the last used time
    sessionConnection.lastUsed = Date.now();
    
    try {
      // Verify the connection is still valid with a simple test query
      await sessionConnection.pool.request().query('SELECT 1 AS connection_test');
      return sessionConnection.pool;
    } catch (err) {
      console.log(`Connection test failed for default session, recreating connection`);
      // Remove the failed connection
      sessionPools.delete(DEFAULT_SESSION_ID);
    }
  }
  
  // Create a new connection
  const connected = await initSqlPool(10000, DEFAULT_SESSION_ID);
  if (connected) {
    return sessionPools.get(DEFAULT_SESSION_ID)?.pool || null;
  }
  
  console.error(`Failed to create default session connection`);
  return null;
}

// Cleanup expired connections
function cleanupExpiredConnections() {
  const now = Date.now();
  
  // Check session pools
  sessionPools.forEach((connection, sessionId) => {
    // NEVER close the default session to maintain persistence
    if (sessionId === DEFAULT_SESSION_ID) {
      // Always update its last used time to prevent it from expiring
      connection.lastUsed = now;
      return;
    }
    
    // For other sessions, check if they've expired
    if (now - connection.lastUsed > CONNECTION_TIMEOUT) {
      console.log(`Closing expired connection for session ${sessionId}, not used for ${(now - connection.lastUsed) / 1000} seconds`);
      try {
        connection.pool.close();
      } catch (error) {
        console.error(`Error closing expired connection for session ${sessionId}:`, error);
      }
      sessionPools.delete(sessionId);
    }
  });
}

// Create an MCP server - the session management is handled by the transport
const server = new McpServer({
  name: mcpConfig.name,
  version: mcpConfig.version
});

// SQL query execution tool
server.tool(
  "execute_query",
  {
    query: z.string().describe("SQL query to execute"),
    database: z.string().optional().describe("Target database name")
  },
  async (args, context) => {
    const { query, database = sqlConfig.database } = args;
    
    // Using persistent default session
    console.log(`Executing query on ${database}: ${query}`);
    
    // Get the default connection pool
    const currentPool = await getConnectionPool();
    if (!currentPool) {
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify({
            error: "Failed to connect to SQL Server. Please check your connection settings."
          }, null, 2)
        }]
      };
    }
    
    try {
      // If database is different from the config, use it
      if (database !== sqlConfig.database) {
        // Ensure database is a string
        const dbName = typeof database === 'string' ? database : String(database);
        
        // Validate database name against valid pattern (alphanumeric plus some safe chars)
        if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) {
          throw new Error('Invalid database name format');
        }
        
        // Sanitize database name to prevent SQL injection
        await currentPool.request()
          .input('database', sql.VarChar, dbName)
          .batch('USE @database');
      }
      
      // Validate query is not empty
      if (!query || query.trim() === '') {
        throw new Error('Query cannot be empty');
      }
      
      // Basic validation to prevent non-SELECT queries and obvious malicious queries
      const lowercaseQuery = query.toLowerCase();
      
      // Handle queries that might start with WITH (CTE), comments, or other SQL constructs
      const normalizedQuery = lowercaseQuery
        .replace(/\/\*.*?\*\//g, '') // Remove /* */ comments
        .replace(/--.*?$/gm, '')     // Remove -- line comments
        .trim();
        
      // Check if this is a SELECT query (also handles WITH clauses)
      const isSelectQuery = normalizedQuery.match(/^(with\s+.*?\s+as\s+\(.*?\)\s+)?select\s/i) !== null;
      
      if (!isSelectQuery) {
        throw new Error('Only SELECT queries are allowed. DELETE, INSERT, UPDATE, and other operations are not permitted.');
      }
      
      if (lowercaseQuery.includes('exec ') || 
          lowercaseQuery.includes('execute ') || 
          lowercaseQuery.includes('sp_') || 
          lowercaseQuery.includes('xp_') ||
          lowercaseQuery.includes('reconfigure') ||
          lowercaseQuery.includes('waitfor delay')) {
        throw new Error('Potentially unsafe query detected. Stored procedures and system procedures are not allowed.');
      }
      
      // Use parameterized query when possible, though this is limited
      // For full protection, application should implement proper query building
      const result = await currentPool.request().query(query);
      
      // Process and format the SELECT query results
      if (result.recordset && result.recordset.length > 0) {
        const columns = Object.keys(result.recordset[0]);
        const rows = result.recordset.map(row => columns.map(col => row[col]));
        
        // Store the response to return after cleanup
        const response = {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              columns,
              rows,
              recordCount: result.recordset.length
            })
          }]
        };

        console.log("Query executed successfully.");
        return response;
      } else {
        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              message: "Query executed successfully, but returned no records"
            }, null, 2)
          }]
        };
      }
    } catch (error: unknown) {
      console.error('SQL query error:', error);
      
      // Improved error handling
      const err = error as Error;
      let errorMessage = err.message || String(error);
      let errorType = 'QUERY_ERROR';
      
      if (errorMessage.includes('syntax error')) {
        errorType = 'SYNTAX_ERROR';
      } else if (errorMessage.includes('permission')) {
        errorType = 'PERMISSION_ERROR';
      } else if (errorMessage.includes('constraint')) {
        errorType = 'CONSTRAINT_ERROR';
      } else if (errorMessage.includes('timeout')) {
        errorType = 'TIMEOUT_ERROR';
      } else if (errorMessage.includes('connect')) {
        errorType = 'CONNECTION_ERROR';
        // Reconnect using default session ID
        const reconnected = await initSqlPool(10000, DEFAULT_SESSION_ID);
        if (!reconnected) {
          errorType = 'FATAL_CONNECTION_ERROR';
        }
      }
      
      // Always return a proper error response
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify({
            error: errorMessage,
            errorType,
            query: query.length > 100 ? query.substring(0, 100) + '...' : query // Truncate long queries
          }, null, 2)
        }]
      };
    }
  }
);

// Stored procedure execution tool
server.tool(
  "execute_StoredProcedure",
  {
    procedure: z.string().describe("Stored procedure name to execute"),
    parameters: z.array(
      z.object({
        name: z.string().describe("Parameter name"),
        type: z.string().describe("SQL parameter type (e.g., 'VarChar', 'Int')"),
        value: z.any().describe("Parameter value")
      })
    ).optional().describe("Parameters for the stored procedure"),
    database: z.string().optional().describe("Target database name")
  },
  async (args, context) => {
    const { procedure, parameters = [], database = sqlConfig.database } = args;
    
    // Using persistent default session
    console.log(`Executing stored procedure ${procedure} on ${database}`);
    
    // Get the default connection pool
    const currentPool = await getConnectionPool();
    if (!currentPool) {
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify({
            error: "Failed to connect to SQL Server. Please check your connection settings."
          }, null, 2)
        }]
      };
    }
    
    try {
      // If database is different from the config, use it
      if (database !== sqlConfig.database) {
        // Ensure database is a string
        const dbName = typeof database === 'string' ? database : String(database);
        
        // Validate database name against valid pattern (alphanumeric plus some safe chars)
        if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) {
          throw new Error('Invalid database name format');
        }
        
        // Sanitize database name to prevent SQL injection
        await currentPool.request()
          .input('database', sql.VarChar, dbName)
          .batch('USE @database');
      }
      
      // Validate procedure name is not empty
      if (!procedure || procedure.trim() === '') {
        throw new Error('Procedure name cannot be empty');
      }
      
      // Validate procedure name format for basic security
      if (!/^([a-zA-Z0-9_]+\.)?[a-zA-Z0-9_]+$/.test(procedure)) {
        throw new Error('Invalid procedure name format. Use [schema].[procedure_name]');
      }
      
      // Build the request with parameters
      const request = currentPool.request();
      
      // Add parameters to the request
      for (const param of parameters) {
        if (!param.name || !param.type) {
          throw new Error('Each parameter must have a name and type');
        }
        
        // Clean parameter name (remove @ if provided)
        const paramName = param.name.startsWith('@') ? param.name : `@${param.name}`;
        
        // Map string type names to sql.* types
        let sqlType;
        switch (param.type.toLowerCase()) {
          case 'varchar':
            sqlType = sql.VarChar;
            break;
          case 'nvarchar':
            sqlType = sql.NVarChar;
            break;
          case 'int':
            sqlType = sql.Int;
            break;
          case 'bigint':
            sqlType = sql.BigInt;
            break;
          case 'float':
            sqlType = sql.Float;
            break;
          case 'decimal':
            sqlType = sql.Decimal;
            break;
          case 'bit':
            sqlType = sql.Bit;
            break;
          case 'date':
            sqlType = sql.Date;
            break;
          case 'datetime':
            sqlType = sql.DateTime;
            break;
          case 'uniqueidentifier':
            sqlType = sql.UniqueIdentifier;
            break;
          default:
            sqlType = sql.VarChar; // Default to VarChar
        }
        
        request.input(paramName.replace('@', ''), sqlType, param.value);
      }
      
      // Execute the stored procedure
      const result = await request.execute(procedure);
      
      // Process the result
      if (result.recordset && result.recordset.length > 0) {
        const columns = Object.keys(result.recordset[0]);
        const rows = result.recordset.map(row => columns.map(col => row[col]));
        
        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              columns,
              rows,
              recordCount: result.recordset.length,
              outputParameters: result.output,
              returnValue: result.returnValue
            }, null, 2)
          }]
        };
      } else {
        return {
          content: [{ 
            type: "text" as const, 
            text: JSON.stringify({
              message: "Stored procedure executed successfully, but returned no records",
              outputParameters: result.output,
              returnValue: result.returnValue,
              rowsAffected: result.rowsAffected
            }, null, 2)
          }]
        };
      }
    } catch (error: unknown) {
      console.error('Stored procedure execution error:', error);
      
      // Provide more user-friendly error messages
      const err = error as Error;
      let errorMessage = err.message || String(error);
      let errorType = 'PROCEDURE_ERROR';
      
      if (errorMessage.includes('syntax error')) {
        errorType = 'SYNTAX_ERROR';
      } else if (errorMessage.includes('permission')) {
        errorType = 'PERMISSION_ERROR';
      } else if (errorMessage.includes('constraint')) {
        errorType = 'CONSTRAINT_ERROR';
      } else if (errorMessage.includes('timeout')) {
        errorType = 'TIMEOUT_ERROR';
      } else if (errorMessage.includes('connect')) {
        errorType = 'CONNECTION_ERROR';
        // Reconnect using default session ID
        const reconnected = await initSqlPool(10000, DEFAULT_SESSION_ID);
        if (!reconnected) {
          errorType = 'FATAL_CONNECTION_ERROR';
        }
      }
      
      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify({
            error: errorMessage,
            errorType,
            procedure
          }, null, 2)
        }]
      };
    }
  }
);

// Database schema resource
server.resource(
  "schema",
  new ResourceTemplate("schema://{database}", { list: undefined }),
  async (uri, { database = sqlConfig.database }, context) => {
    // Using persistent default session
    console.log(`Fetching schema for database: ${database}`);
    
    // Get the default connection pool
    const currentPool = await getConnectionPool();
    if (!currentPool) {
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            error: "Failed to connect to SQL Server. Please check your connection settings."
          }, null, 2)
        }]
      };
    }
    
    try {
      // If database is different from the config, use it
      if (database !== sqlConfig.database) {
        // Ensure database is a string
        const dbName = typeof database === 'string' ? database : String(database);
        
        // Validate database name against valid pattern (alphanumeric plus some safe chars)
        if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) {
          throw new Error('Invalid database name format');
        }
        
        // Sanitize database name to prevent SQL injection
        await currentPool.request()
          .input('database', sql.VarChar, dbName)
          .batch('USE @database');
      }
      
      // Query to get all tables in the database
      const tablesResult = await currentPool.request().query(`
        SELECT TABLE_SCHEMA, TABLE_NAME 
        FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_TYPE = 'BASE TABLE' 
        ORDER BY TABLE_SCHEMA, TABLE_NAME
      `);
      
      const tables: TableSchema[] = [];
      
      // For each table, get its columns
      for (const table of tablesResult.recordset) {
        const tableName = `${table.TABLE_SCHEMA}.${table.TABLE_NAME}`;
        
        // Query to get columns for this table
        const columnsResult = await currentPool.request()
          .input('schema', sql.VarChar, table.TABLE_SCHEMA.toString())
          .input('table', sql.VarChar, table.TABLE_NAME.toString())
          .query(`
            SELECT 
              c.COLUMN_NAME, 
              c.DATA_TYPE,
              c.CHARACTER_MAXIMUM_LENGTH,
              c.NUMERIC_PRECISION,
              c.NUMERIC_SCALE,
              c.IS_NULLABLE,
              CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY
            FROM 
              INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
              SELECT 
                ku.TABLE_CATALOG,
                ku.TABLE_SCHEMA,
                ku.TABLE_NAME,
                ku.COLUMN_NAME
              FROM 
                INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS ku
                  ON tc.CONSTRAINT_TYPE = 'PRIMARY KEY' 
                  AND tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            ) pk
            ON 
              c.TABLE_SCHEMA = pk.TABLE_SCHEMA
              AND c.TABLE_NAME = pk.TABLE_NAME
              AND c.COLUMN_NAME = pk.COLUMN_NAME
            WHERE 
              c.TABLE_SCHEMA = @schema
              AND c.TABLE_NAME = @table
            ORDER BY 
              c.ORDINAL_POSITION
          `);
        
        const columns = columnsResult.recordset.map(col => {
          let type = col.DATA_TYPE;
          
          // Add length/precision/scale where applicable
          if (col.CHARACTER_MAXIMUM_LENGTH) {
            type += `(${col.CHARACTER_MAXIMUM_LENGTH})`;
          } else if (col.NUMERIC_PRECISION && col.NUMERIC_SCALE) {
            type += `(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
          }
          
          return {
            name: col.COLUMN_NAME,
            type,
            nullable: col.IS_NULLABLE === 'YES',
            primary: col.IS_PRIMARY_KEY === 1
          };
        });
        
        tables.push({
          schema: table.TABLE_SCHEMA,
          name: table.TABLE_NAME,
          fullName: tableName,
          columns
        });
      }
      
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ tables }, null, 2)
        }]
      };
    } catch (error: unknown) {
      console.error('Schema query error:', error);
      
      // Check if this is a connection error
      const err = error as any; // Using any since we need to access custom properties
      if ((err.message && err.message.includes('connect')) || (err.code && err.code === 'ESOCKET')) {
        // Reconnect using default session ID
        console.log('Connection issue detected, attempting to reconnect...');
        const reconnected = await initSqlPool(10000, DEFAULT_SESSION_ID);
        if (!reconnected) {
          console.error('Failed to reconnect after schema query error');
        }
      }
      
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            error: err.message,
            errorType: err.code || 'SCHEMA_ERROR'
          }, null, 2)
        }]
      };
    }
  }
);

// Instead of trying to modify the transport class which is complex,
// let's use a different approach by using the standard transport
// and ensuring our tool handlers always maintain connection state
const transport = new StdioServerTransport();

// Cleanup resources on shutdown
async function cleanup() {
  console.log(`[${new Date().toISOString()}] Shutting down server, cleaning up resources...`);
  
  // Clear the keep-alive interval if it exists
  if ((global as any).keepAliveIntervalId) {
    clearInterval((global as any).keepAliveIntervalId);
    console.log(`[${new Date().toISOString()}] Cleared keep-alive interval`);
  }
  
  try {
    
    // Close all session pools
    if (sessionPools.size > 0) {
      console.log(`[${new Date().toISOString()}] Closing ${sessionPools.size} session connection pools...`);
      
      // Close each session pool except the default session
      const closingPromises = [];
      for (const [sessionId, sessionConnection] of sessionPools.entries()) {
        // Skip closing the default session to avoid connection issues on restart
        if (sessionId === DEFAULT_SESSION_ID) {
          console.log(`[${new Date().toISOString()}] Skipping default session ${DEFAULT_SESSION_ID} during cleanup to maintain persistence`);
          continue;
        }
        
        try {
          closingPromises.push(
            sessionConnection.pool.close()
              .then(() => console.log(`[${new Date().toISOString()}] Session pool ${sessionId} closed successfully`))
              .catch(err => console.error(`[${new Date().toISOString()}] Error closing session pool ${sessionId}: ${err.message}`))
          );
        } catch (error: unknown) {
          const err = error as Error;
          console.error(`[${new Date().toISOString()}] Error closing session pool ${sessionId}: ${err.message}`);
        }
      }
      
      // Wait for all close operations to complete
      await Promise.allSettled(closingPromises);
      
      // Clear all session pools except the default one
      const defaultSession = sessionPools.get(DEFAULT_SESSION_ID);
      sessionPools.clear();
      
      // Restore the default session if it existed
      if (defaultSession) {
        sessionPools.set(DEFAULT_SESSION_ID, defaultSession);
        console.log(`[${new Date().toISOString()}] Non-default session pools have been closed, maintained default session ${DEFAULT_SESSION_ID}`);
      } else {
        console.log(`[${new Date().toISOString()}] All session pools have been closed`);
      }
    } else {
      console.log(`[${new Date().toISOString()}] No active session pools to close`);
    }
    
    console.log(`[${new Date().toISOString()}] Cleanup complete`);
    return true;
  } catch (finalError: unknown) {
    const err = finalError as Error;
    console.error(`[${new Date().toISOString()}] Unexpected error during cleanup: ${err.message}`);
    return false;
  }
}

// Setup process signal handlers
process.on('SIGINT', async () => {
  console.log(`[${new Date().toISOString()}] Received SIGINT signal`);
  const cleanupSuccess = await cleanup();
  // Exit with appropriate code (0 for success, 1 for errors)
  process.exit(cleanupSuccess ? 0 : 1);
});

process.on('SIGTERM', async () => {
  console.log(`[${new Date().toISOString()}] Received SIGTERM signal`);
  const cleanupSuccess = await cleanup();
  // Exit with appropriate code (0 for success, 1 for errors)
  process.exit(cleanupSuccess ? 0 : 1);
});

// Initialize and run
async function main() {
  console.log(`[${new Date().toISOString()}] Starting MSSQL MCP server...`);
  console.log(`SQL Server config: ${sqlConfig.server}:${sqlConfig.port}, Database: ${sqlConfig.database}`);
  
  // Set up global error handlers
  process.on('uncaughtException', (error) => {
    console.error(`[${new Date().toISOString()}] UNCAUGHT EXCEPTION:`, error);
    cleanup().finally(() => process.exit(1));
  });
  
  process.on('unhandledRejection', (reason) => {
    console.error(`[${new Date().toISOString()}] UNHANDLED REJECTION:`, reason);
    // Don't exit here to allow the promise to be caught elsewhere
  });
  
  // Set up a periodic interval to keep the default session alive
  const keepAliveIntervalId = setInterval(async () => {
    try {
      await keepDefaultSessionAlive();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error in keep-alive interval:`, error);
    }
  }, KEEP_ALIVE_INTERVAL);
  
  // Store the interval ID so it can be cleared during cleanup
  (global as any).keepAliveIntervalId = keepAliveIntervalId;
  
  // Initialize with validation and timeout
  // Always use DEFAULT_SESSION_ID to ensure we have a persistent connection
  console.log(`[${new Date().toISOString()}] Initializing database connection with default session ID: ${DEFAULT_SESSION_ID}`);
  
  // Create our persistent default session
  const connected = await initSqlPool(15000, DEFAULT_SESSION_ID); // 15 second timeout
  
  // Verify the default session was established
  if (connected) {
    console.log(`[${new Date().toISOString()}] Successfully established default session connection: ${DEFAULT_SESSION_ID}`);
    
    // Do a test query to validate the connection
    try {
      const sessionConnection = sessionPools.get(DEFAULT_SESSION_ID);
      if (sessionConnection) {
        await sessionConnection.pool.request().query('SELECT 1 AS connection_test');
        console.log(`[${new Date().toISOString()}] Default session connection verified with test query`);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Default session test query failed:`, err);
    }
  }
  if (!connected) {
    console.error(`[${new Date().toISOString()}] Failed to connect to SQL Server. Exiting.`);
    console.log(`Server: ${sqlConfig.server}`);
    console.log(`Port: ${sqlConfig.port}`);
    console.log(`User: ${sqlConfig.user}`);
    console.log(`Database: ${sqlConfig.database}`);
    console.log(`Password: ${sqlConfig.password ? 'Provided' : 'Not provided'}`);
    console.log(`NOTE: You must set SQL_PASSWORD environment variable with the correct password`);
    process.exit(1);
  }
  
  console.log(`[${new Date().toISOString()}] Connected to SQL Server`);
  
  // Test connection is already verified in new initSqlPool implementation
  
  // Start the MCP server transport with better error handling
  console.log(`[${new Date().toISOString()}] Starting MCP server transport...`);
  try {
    // The connect method doesn't need awaiting for StdioServerTransport
    server.connect(transport);
    console.log(`[${new Date().toISOString()}] MCP server ready with session support enabled`);
    
    // Log the default session ID that will be used 
    console.log(`[${new Date().toISOString()}] Using default session ID: ${DEFAULT_SESSION_ID} for connection persistence`);
    
    // Log that we're ready to accept requests for tools
    console.log(`[${new Date().toISOString()}] Available tools: execute_query, execute_StoredProcedure`);
    console.log(`[${new Date().toISOString()}] Available resources: schema://database`);
    console.log(`[${new Date().toISOString()}] MCP server is listening on stdio...`);
    
    // Set up stdin/stdout handlers for debugging
    process.stdin.on('data', (data) => {
      console.error(`[${new Date().toISOString()}] STDIN received:`, data.toString().trim());
    });
    
    process.stdout.on('error', (error) => {
      console.error(`[${new Date().toISOString()}] STDOUT error:`, error);
    });
  } catch (error: unknown) {
    console.error(`[${new Date().toISOString()}] Failed to start MCP server transport:`, error);
  }
}

main().catch(async (error: unknown) => {
  console.error("Server error:", error);
  await cleanup();
  process.exit(1);
});