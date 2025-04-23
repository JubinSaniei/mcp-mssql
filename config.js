// SQL Server connection configuration
// Primary defaults are in docker-compose.yml, but we provide fallbacks here
// for direct execution outside of Docker
export const sqlConfig = {
  // Connection settings
  server: process.env.SQL_SERVER || '172.31.64.1', // your server IP or hostname
  port: parseInt(process.env.SQL_PORT || '1433'),
  user: process.env.SQL_USER || 'sa',
  password: process.env.SQL_PASSWORD || '',  // Empty string will trigger error message
  database: process.env.SQL_DATABASE || 'DatabaseName', // your database name
  
  // Security options
  options: {
    encrypt: process.env.SQL_ENCRYPT !== 'false', // Default to true
    trustServerCertificate: process.env.SQL_TRUST_SERVER_CERT !== 'false', // Default to true
  },
  
  // Timeouts
  connectionTimeout: parseInt(process.env.SQL_CONNECTION_TIMEOUT || '30000'),
  requestTimeout: parseInt(process.env.SQL_REQUEST_TIMEOUT || '30000'),
  
  // Connection pool settings
  pool: {
    max: parseInt(process.env.SQL_POOL_MAX || '10'),
    min: parseInt(process.env.SQL_POOL_MIN || '0'),
    idleTimeoutMillis: parseInt(process.env.SQL_POOL_IDLE_TIMEOUT || '30000')
  }
};

// MCP server configuration
export const mcpConfig = {
  name: process.env.MCP_SERVER_NAME || "MSSQL Server",
  version: process.env.MCP_SERVER_VERSION || "1.0.0"
};