# MCP MSSQL Server

This is a Model Context Protocol (MCP) server for SQL Server interactions. It allows Large Language Models (LLMs) to execute SQL queries, run stored procedures, and explore database schemas with enhanced security and robustness.

## Features

- **Read-Only SQL Query Execution**: Run single-statement `SELECT` queries against SQL Server databases. Every query is validated and then run inside a transaction that is always rolled back. Results are streamed and paged, so only the requested page is held in memory.
- **Allow-Listed Stored Procedures**: Execute stored procedures named in `SQL_ALLOWED_PROCEDURES`, with typed input and output parameters. Without an allow-list the tool is not offered at all.
- **Schema Exploration**: View tables and views with their columns, primary keys and foreign keys, with results cached for performance.
- **Robust Connection Management**: One connection pool per database, created on first use and reused across calls, with configurable retry logic and timeouts. The server starts answering MCP requests without waiting for the database.
- **Enhanced Security**:
    - T-SQL-aware validation that accepts exactly one `SELECT` (or `WITH ... SELECT`) statement.
    - Every query and procedure call runs in a transaction that is always rolled back.
    - `SQL_ALLOWED_DATABASES` environment variable to whitelist accessible databases, including 3-part names inside queries.
    - `SQL_ALLOWED_PROCEDURES` allow-list for stored procedures.
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

The server is configured using environment variables, read and validated by `config.ts`. The server does not read a `.env` file itself: Docker Compose loads `.env` from the project root, and when running locally you can pass it with `node --env-file=.env dist/server.js` (you can start from `.env.example`).

Numbers must be whole numbers within their allowed range; an invalid value (for example `SQL_PORT=abc`) stops the server at startup with a message naming the variable. An unset or empty variable takes its default.

For a detailed guide on all configuration options and how to set them up, please see [`CONFIG`](docs/CONFIG.md).

| Category | Variable                    | Description                                                                 | Default (from config.ts) |
|----------|-----------------------------|-----------------------------------------------------------------------------|--------------------------|
| **Connection** | `SQL_SERVER`                | SQL Server hostname or IP                                                   | `localhost`              |
|          | `SQL_PORT`                  | SQL Server port                                                             | `1433`                   |
|          | `SQL_USER`                  | SQL Server username                                                         | `sa`                     |
|          | `SQL_PASSWORD`              | SQL Server password                                                         | `yourStrong(!)Password`  |
|          | `SQL_DATABASE`              | Default database name to connect to                                         | `master`                 |
| **Security** | `SQL_ENCRYPT`               | Encrypt the connection; only the value `false` disables it                  | `true`                   |
|          | `SQL_TRUST_SERVER_CERT` / `SQL_TRUST_SERVER_CERTIFICATE` | Trust the server certificate; only the value `true` enables it (either name works) | `false`                  |
|          | `SQL_ALLOWED_DATABASES`     | Comma-separated list of databases the server is allowed to access. If empty, access is less restricted (relies on DB user permissions). | `[]` (empty list)        |
|          | `SQL_ALLOWED_PROCEDURES`    | Comma-separated list of stored procedures `execute_stored_procedure` may run, as schema-qualified `schema.proc` or `[schema].[proc]` (case-insensitive). Entries without a schema are ignored with a warning. If no valid entry remains, the `execute_stored_procedure` tool is not registered. | `[]` (empty list)        |
| **Results** | `SQL_MAX_ROWS`              | Maximum rows returned per result set                                        | `1000`                   |
| **Timeouts & Retries** | `SQL_CONNECTION_TIMEOUT`    | Connection timeout (ms)                                                     | `15000`                  |
|          | `SQL_REQUEST_TIMEOUT`       | Request timeout for queries (ms)                                            | `15000`                  |
|          | `SQL_RETRY_MAX_RETRIES`     | Connection attempts per pool connect                                        | `3`                      |
|          | `SQL_RETRY_DELAY_MS`        | Initial delay (ms) before retrying a failed connection                      | `1000`                   |
|          | `SQL_RETRY_MAX_DELAY_MS`    | Maximum delay (ms) between connection retries (exponential backoff)         | 10 × `SQL_RETRY_DELAY_MS` (`10000`) |
| **Connection Pool** | `SQL_POOL_MAX`              | Max connections in each pool                                                | `10`                     |
|          | `SQL_POOL_MIN`              | Min connections in each pool (must not exceed `SQL_POOL_MAX`)               | `0`                      |
|          | `SQL_POOL_IDLE_TIMEOUT`     | Idle timeout for connections in a pool (ms)                                 | `30000`                  |
| **Caching**  | `CACHE_TTL_MS`              | Time-To-Live for schema cache (ms)                                          | `300000` (5 minutes)     |
| **Logging**  | `LOG_LEVEL`                 | Log level for the pino logger: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs go to stderr. | `info`                   |

The MCP server name (`mssql-mcp`) is fixed, and its version is read from `package.json`.


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

2.  Execute stored procedures (only available when `SQL_ALLOWED_PROCEDURES` is set, and only for the procedures it lists):
    ```xml
    <mcp:execute_stored_procedure database="YourDatabaseName">
    {
      "procedure": "YourSchema.YourProcedureName",
      "parameters": [
        {"name": "Param1", "type": "nvarchar", "length": 50, "value": "SomeValue"},
        {"name": "Param2", "type": "decimal", "precision": 18, "scale": 2, "value": 12.5},
        {"name": "Total", "type": "int", "direction": "out"}
      ]
    }
    </mcp:execute_stored_procedure>
    ```
    The procedure name must be schema-qualified. `type` must be a SQL Server type name (case-insensitive); unknown types are rejected. Output parameter values are returned in `outputParameters`.

3.  Explore database schema:
    ```xml
    <mcp:schema>
    YourDatabaseName
    </mcp:schema>
    ```
    (If `YourDatabaseName` is omitted, it defaults to the `SQL_DATABASE` specified in the environment variables.)

## Connection Handling

The `DatabaseService` keeps one `mssql` connection pool per database, keyed case-insensitively by database name.
- **Efficiency**: Each pool is created on first use and reused by later calls to the same database. Pools for databases other than `SQL_DATABASE` are closed after 10 minutes without use.
- **Startup**: The MCP transport starts first; the default pool connects in the background. If the database is down, the server still starts, and tool calls return a connection error (`errorType: "ConnectionError"`) until it is reachable again.
- **Resilience**: Connecting retries with exponential backoff (`SQL_RETRY_*`); concurrent calls share one connection attempt. A rejected login is not retried. A pool whose connection is lost (`ESOCKET` / `ECONNCLOSED`) is replaced on the next call; the failed call itself is not retried.
- **Cancellation**: When the MCP client cancels a call, the running SQL is cancelled and its transaction rolled back.
- **No Session State Across Calls**: Each call runs in its own rolled-back transaction on whichever pooled connection is free, so temporary tables or session variables created in one call are not available in another.

## Results and Errors

- Results are compact JSON. Binary values are returned as `0x...` hex strings (truncated after 64 bytes, with the full length noted), and `bigint` values as strings.
- Date and time values, in result sets and in stored procedure output parameters, are returned as their exact SQL text, with as many fractional-second digits as the column's declared scale. They never depend on the server's time zone:

  | Type | Example |
  | --- | --- |
  | `date` | `"2026-10-01"` |
  | `time(n)` | `"13:45:00.1234567"` (`time(0)`: `"13:45:00"`) |
  | `datetime2(n)` | `"2026-10-01T12:34:56.1234567"` (no `Z`, no offset) |
  | `datetimeoffset(n)` | `"2026-10-01T12:34:56.1234567+05:30"` (the stored offset) |
  | `datetime` | `"2026-10-01T12:34:56.123"` |
  | `smalldatetime` | `"2026-10-01T12:34:00"` |

  The `mssql`/`tedious` driver drops the offset of `datetimeoffset` values. To keep it, the server wraps the driver's internal value reader (`tedious/lib/value-parser.js`) at startup, after a self-check confirms that the wrapper recovers known offsets. If the self-check fails (for example after a `tedious` upgrade changes that internal module), the server logs a warning, and `datetimeoffset` values are returned as the same instant in UTC, e.g. `"2026-10-01T07:04:56.1234567+00:00"`. The tool descriptions say which mode is active.
- A date/time value inside a `sql_variant` column is returned as date-and-time text with trailing fractional zeros removed, e.g. `"2026-10-01T12:34:56.5"`. The driver does not report the base type or scale of a variant, so a `date` value appears as `"2026-10-01T00:00:00"` and a `time` value as `"1970-01-01T13:45:00"`. A `datetimeoffset` value keeps its stored offset and is returned as its local time plus that offset, e.g. `"2026-10-01T07:18:20+05:30"`. If the self-check has failed (`utc-fallback` mode), a variant `datetimeoffset` cannot be told apart from a `datetime2`: it is returned as its UTC time with no offset marker, e.g. `"2026-10-01T01:48:20"`.
- `execute_query` returns `recordsets` (each with `columns`, positional `rows`, `recordCount`, `hasMore` and, when there are more rows, `nextOffset`) and `pagination` (`offset`, `limit`, `hasMore`, `nextOffset`, `returnedRowCount`). `limit` defaults to `SQL_MAX_ROWS`, and larger values are capped at it. Each page re-runs the query, so use `ORDER BY` for stable pages.
- `execute_stored_procedure` returns `recordsets` (each capped at `SQL_MAX_ROWS` rows; `hasMore` marks a capped result set), `outputParameters`, `returnValue` and `rowsAffected`.
- Errors are returned as `{ "error", "errorType", "code", "sqlErrorNumber" }`; `code` is the driver error code (e.g. `ETIMEOUT`, `ESOCKET`, `EREQUEST`) and `sqlErrorNumber` the SQL Server error number, when present. Query timeouts are reported as `QueryTimeout`, connection timeouts as `ConnectionTimeout`, and client cancellations as `Cancelled`. Stack traces stay in the server log.

## Development

### Local Development Setup

```bash
# Install dependencies
npm install

# Create and configure your .env file
cp .env.example .env
nano .env

# Run the server from source with tsx (`npm run dev` does the same; environment variables must be set)
npm start

# Or build and run the compiled server
npm run build
node --env-file=.env dist/server.js

# Checks
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm test            # vitest
```

## Security Notes

### Read-only guarantees

- **Single-statement `SELECT` validation**: `execute_query` accepts exactly one statement, and it must start with `SELECT` or `WITH`. The query is tokenised with T-SQL rules (`'...'` strings with `''` escapes, `N'...'`, `[...]` and `"..."` identifiers, `--` and nested `/* */` comments), so keywords inside strings, comments or bracketed names are ignored, and a second statement can't be hidden inside something that only looks like a string. Statement separators, `GO`, and keywords such as `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `EXEC`, `INTO`, `OPENQUERY`, `OPENROWSET`, `WAITFOR`, `DECLARE` or `SET` are rejected. The query must also parse as a single `SELECT`.
- **Always rolled back**: every `execute_query` call, and every allowed stored procedure call, runs as `BEGIN TRANSACTION` → statement → `ROLLBACK`, whether the statement succeeds, fails, is cut off once the requested page is full, or is cancelled by the client. Any change a transaction can undo is discarded, and the connection goes back to the pool with no open transaction; if the rollback itself fails, that connection is closed and its pool replaced. Actions a transaction can't undo, such as some system procedures, linked-server calls or `BACKUP`, are not covered by this backstop.
- **Procedures are allow-list only**: `execute_stored_procedure` runs only the procedures named in `SQL_ALLOWED_PROCEDURES`. Names must be schema-qualified (`schema.proc` or `[schema].[proc]`) and are compared case-insensitively; an unqualified name is rejected, because SQL Server would resolve it against the caller's default schema. Any other name is rejected with a permission error. When the list has no valid entries, the tool is not registered at all. The outer rollback does **not** undo changes a procedure commits itself (for example with its own `COMMIT`, or a `ROLLBACK` followed by further writes), so allow-list only procedures you trust to be read-only.
- **Database Whitelisting**: Use the `SQL_ALLOWED_DATABASES` environment variable to restrict which databases the server can interact with. 3-part names in queries (`OtherDb.dbo.Table`) are checked against the same list, and 4-part (linked-server) names are rejected. For details, see [`DATABASE_WHITELISTING.md`](docs/DATABASE_WHITELISTING.md).
- **Input Validation**: Database names and stored procedure names undergo format validation.
- **Parameterized Inputs**: Stored procedure parameters are passed as typed parameters by the `mssql` library, not concatenated into SQL.

### Recommended: read-only database login

The checks above reduce risk, but the only airtight guarantee is a login that cannot write. Connect the server with a dedicated login that is a member of `db_datareader`, has `EXECUTE` denied, and is mapped only into the databases listed in `SQL_ALLOWED_DATABASES`:

```sql
CREATE LOGIN mcp_reader WITH PASSWORD = '<strong password>';

-- Repeat in each allowed database
USE YourDatabaseName;
CREATE USER mcp_reader FOR LOGIN mcp_reader;
ALTER ROLE db_datareader ADD MEMBER mcp_reader;
DENY EXECUTE TO mcp_reader;
```

If you allow specific procedures through `SQL_ALLOWED_PROCEDURES`, grant `EXECUTE` on just those procedures instead of denying it database-wide (a database-level `DENY EXECUTE` overrides object-level grants).

## Troubleshooting

If you encounter issues:

1.  Check container logs: `docker logs mssql-mcp` (if using Docker).
2.  Check the server's console output for pino logs if running locally.
3.  Verify all required environment variables in your `.env` file are correctly set, especially `SQL_PASSWORD`, `SQL_SERVER`, `SQL_USER`, and `SQL_DATABASE`.
4.  Ensure the database(s) you are trying to access are listed in `SQL_ALLOWED_DATABASES` if you have set this variable. A `PermissionError` saying a database "is not on this server's list of allowed databases, or it does not exist" means the name matched no entry (names compare case-insensitively, with `[...]` or `"..."` delimiters removed). Without the variable, `sqlErrorNumber` `4060` ("Cannot open database") means the database doesn't exist or the login can't access it.
5.  Confirm network connectivity to your SQL Server instance from where the MCP server is running.
6.  Run `npm test` to check the query validator and the rest of the unit tests; they need no database.

For detailed Docker troubleshooting, see the [Docker README](docs/README.docker.md).