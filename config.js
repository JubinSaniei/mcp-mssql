// SQL Server connection configuration
// Environment variables are loaded from .env file
// Only minimal fallbacks are provided for critical values to prevent crashes
export const sqlConfig = {
  user: process.env.SQL_USER || "sa",
  password: process.env.SQL_PASSWORD || "yourStrong(!)Password",
  server: process.env.SQL_SERVER || "localhost",
  database: process.env.SQL_DATABASE || "master",
  port: parseInt(process.env.SQL_PORT || "1433", 10),
  connectionTimeout: parseInt(process.env.SQL_CONNECTION_TIMEOUT || "15000", 10),
  requestTimeout: parseInt(process.env.SQL_REQUEST_TIMEOUT || "15000", 10),
  pool: {
    max: parseInt(process.env.SQL_POOL_MAX || "10", 10),
    min: parseInt(process.env.SQL_POOL_MIN || "0", 10),
    idleTimeoutMillis: parseInt(process.env.SQL_POOL_IDLE_TIMEOUT || "30000", 10),
  },
  options: {
    encrypt: process.env.SQL_ENCRYPT === "true", // Use this if you're on Azure
    trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE === "true", // Change to true for local dev / self-signed certs
  },
  // Flattened retry configuration to match SqlConfig interface
  maxRetries: parseInt(process.env.SQL_RETRY_MAX_RETRIES || "3", 10),
  initialRetryDelay: parseInt(process.env.SQL_RETRY_DELAY_MS || "1000", 10),
  maxRetryDelay: parseInt(process.env.SQL_RETRY_MAX_DELAY_MS || (parseInt(process.env.SQL_RETRY_DELAY_MS || "1000", 10) * 10).toString(), 10), // Default max delay to 10x initial delay
  
  // Renamed cacheTTL to schemaCacheTTL to match SqlConfig interface
  schemaCacheTTL: parseInt(process.env.CACHE_TTL_MS || "300000", 10), // 5 minutes

  allowedDatabases: (process.env.SQL_ALLOWED_DATABASES || "").split(",").filter(Boolean),
  logLevel: process.env.LOG_LEVEL || "info",
};