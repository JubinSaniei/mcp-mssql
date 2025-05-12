# MCP MSSQL Server

This is a Model Context Protocol (MCP) server for SQL Server interactions. It allows Large Language Models (LLMs) to execute SQL queries, run stored procedures, and explore database schemas with enhanced security and robustness.

## Features

- **Secure SQL Query Execution**: Run `SELECT` queries against SQL Server databases. All queries are parsed and validated to ensure only `SELECT` statements are executed.
- **Stored Procedure Support**: Execute stored procedures with parameterized inputs.
- **Schema Exploration**: View database table and column definitions, with results cached for performance.
- **Robust Connection Management**: Utilizes a global connection pool for efficient reuse of database connections, with configurable retry logic and timeouts.
- **Enhanced Security**:
    - SQL query parsing and `SELECT`-only whitelist.
    - `SQL_ALLOWED_DATABASES` environment variable to whitelist accessible databases.
    - Protection against common SQL injection patterns for database context switching.
    - Blocks execution of potentially harmful system procedures or commands in direct queries.
- **Configurable Caching**: Database schema information is cached with a configurable Time-To-Live (TTL).
- **Structured Logging**: Integrated `pino` logger for detailed and structured application logs.
- **Docker Ready**: Simple deployment with Docker.

## Quick Start

### Using Docker (Recommended)

```bash
# Clone the repository (if you haven't already)
git clone https://github.com/JubinSaniei/mcp-mssql
# cd mcp-mssql

# Copy example configuration and edit with your settings
cp .env.example .env
nano .env  # Edit with your SQL Server details and other configurations

# Start the Docker container
docker-compose up -d
```

For complete Docker setup instructions, see the [Docker README](docs/README.docker.md).

## Configuration

The server is configured using environment variables. Create a `.env` file in the root directory (you can copy `.env.example`) to set these values.

For a detailed guide on all configuration options and how to set them up, please see [`CONFIG`](docs/CONFIG.md).

| Category | Variable                    | Description                                                                 | Default (from config.js) |
|----------|-----------------------------|-----------------------------------------------------------------------------|--------------------------|
| **Connection** | `SQL_SERVER`                | SQL Server hostname or IP                                                   | `localhost`              |
|          | `SQL_PORT`                  | SQL Server port                                                             | `1433`                   |
|          | `SQL_USER`                  | SQL Server username                                                         | `sa`                     |
|          | `SQL_PASSWORD`              | SQL Server password                                                         | *Required*               |
|          | `SQL_DATABASE`              | Default database name to connect to                                         | `master`                 |
| **Security** | `SQL_ENCRYPT`               | Enable encryption (set to `false` to disable)                               | `true`                   |
|          | `SQL_TRUST_SERVER_CERT`     | Trust server certificate (set to `false` to disable)                        | `true`                   |
|          | `SQL_ALLOWED_DATABASES`     | Comma-separated list of databases the server is allowed to access. If empty, access is less restricted (relies on DB user permissions). | `[]` (empty list)        |
| **Timeouts & Retries** | `SQL_CONNECTION_TIMEOUT`    | Connection timeout (ms)                                                     | `30000`                  |
|          | `SQL_REQUEST_TIMEOUT`       | Request timeout for queries (ms)                                            | `30000`                  |
|          | `SQL_MAX_RETRIES`           | Max number of retries for initial connection attempts                       | `3`                      |
|          | `SQL_INITIAL_RETRY_DELAY`   | Initial delay (ms) before retrying a failed connection                    | `1000`                   |
|          | `SQL_MAX_RETRY_DELAY`       | Maximum delay (ms) for connection retries (uses exponential backoff)        | `30000`                  |
| **Connection Pool** | `SQL_POOL_MAX`              | Max connections in pool                                                     | `10`                     |
|          | `SQL_POOL_MIN`              | Min connections in pool                                                     | `0`                      |
|          | `SQL_POOL_IDLE_TIMEOUT`     | Idle timeout for connections in pool (ms)                                   | `30000`                  |
| **Caching**  | `SQL_SCHEMA_CACHE_TTL`      | Time-To-Live for schema cache (ms)                                          | `300000` (5 minutes)     |
| **MCP Server** | `MCP_SERVER_NAME`           | Name of the MCP server                                                      | `MSSQL Server`           |
|              | `MCP_SERVER_VERSION`        | Version of the MCP server                                                   | `1.0.0`                  |
| **Logging**  | `LOG_LEVEL`                 | Log level for pino logger (e.g., `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`). This is read directly from `process.env` in `server.ts`, not part of `config.js`. | `info`                   |


## Using with Claude

To add this MCP server to Claude CLI:

```bash
# Add the MCP server using the config file
claude mcp add-json mssql-mcp "$(cat claude-mcp-config.json)"

# To add it globally
claude mcp add-json -s user mssql-mcp "$(cat claude-mcp-config.json)"

# Start a conversation with Claude using this MCP
claude mcp mssql-mcp
```

In the Claude conversation, you can:

1.  Execute `SELECT` queries:
    ```xml
    <mcp:execute_query database="YourDatabaseName">
    SELECT TOP 10 * FROM YourTable
    </mcp:execute_query>
    ```
    (The `database` attribute is optional if operating on the default `SQL_DATABASE` or if `SQL_ALLOWED_DATABASES` implies a single choice.)

2.  Execute stored procedures:
    ```xml
    <mcp:execute_StoredProcedure database="YourDatabaseName">
    {
      "procedure": "YourSchema.YourProcedureName",
      "parameters": [
        {"name": "Param1", "type": "NVarChar", "value": "SomeValue"},
        {"name": "Param2", "type": "Int", "value": 123}
      ]
    }
    </mcp:execute_StoredProcedure>
    ```

3.  Explore database schema:
    ```xml
    <mcp:schema>
    YourDatabaseName
    </mcp:schema>
    ```
    (If `YourDatabaseName` is omitted, it defaults to the `SQL_DATABASE` specified in the environment variables.)

## Connection Handling

This MCP server utilizes a global, robust connection pool (`mssql` library's built-in pooling) managed by the `DatabaseService`.
- **Efficiency**: Connections are reused, reducing the overhead of establishing a new connection for each request.
- **Resilience**: Implements retry logic with exponential backoff for initial connection establishment.
- **No Session State Across Calls**: Unlike a session-per-user model, this server does not guarantee that subsequent MCP calls (e.g., two separate `execute_query` calls) from the LLM will use the exact same underlying database connection. Therefore, session-specific state like temporary tables or session variables created in one call may not be available in another. Each call should be considered atomic from a session state perspective. The `USE [database]` command is issued within each operation if the target database differs from the pool's default, ensuring context for that specific operation.

## Development

### Local Development Setup

```bash
# Install dependencies
npm install

# Create and configure your .env file
cp .env.example .env
nano .env

# Run the server directly (requires environment variables to be set)
npm start

# Run with TypeScript compiler watching for changes
npm run dev
```

## Security Notes

- **`SELECT` Only**: The server strictly enforces that only `SELECT` queries can be run via the `execute_query` tool, using SQL parsing. DML (INSERT, UPDATE, DELETE) and DDL statements are blocked.
- **Stored Procedure Execution**: While stored procedures can perform any action their permissions allow, their execution is managed separately.
- **Database Whitelisting**: Use the `SQL_ALLOWED_DATABASES` environment variable to restrict which databases the server can interact with. For a detailed explanation of this feature and how it interacts with `SQL_DATABASE`, please see [`DATABASE_WHITELISTING.md`](docs/DATABASE_WHITELISTING.md).
- **System Procedure Blocking**: Direct execution of common system procedures (e.g., `sp_`, `xp_`) and commands like `RECONFIGURE` or `WAITFOR DELAY` via `execute_query` is blocked. Stored procedures should be used for legitimate system interactions.
- **Input Validation**: Database names for context switching and stored procedure names undergo format validation. SQL parsing provides an additional layer of validation for queries.
- **Parameterized Inputs**: Stored procedure parameters are handled by the `mssql` library, which typically parameterizes them to prevent SQL injection.

## Troubleshooting

If you encounter issues:

1.  Check container logs: `docker logs mssql-mcp` (if using Docker).
2.  Check the server's console output for pino logs if running locally.
3.  Verify all required environment variables in your `.env` file are correctly set, especially `SQL_PASSWORD`, `SQL_SERVER`, `SQL_USER`, and `SQL_DATABASE`.
4.  Ensure the database(s) you are trying to access are listed in `SQL_ALLOWED_DATABASES` if you have set this variable.
5.  Confirm network connectivity to your SQL Server instance from where the MCP server is running.
6.  The test scripts (`test-mcp.sh`, `test-session-persistence.sh`) might need review/updates.

For detailed Docker troubleshooting, see the [Docker README](docs/README.docker.md).