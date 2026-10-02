# Configuration Guide for MCP SQL Server

This document explains how to configure the MCP SQL Server application.

## Configuration Method

The server reads its settings from environment variables; `config.ts` parses and validates them at startup. A `.env` file is the usual place to keep them: Docker Compose loads it automatically, and when running the server directly you pass it to Node (see [Running Without Docker](#running-without-docker)). The server does not read `.env` by itself.

Unset or empty variables take the defaults listed below. Numeric values must be whole numbers within their range (for example `SQL_PORT` 1–65535, `SQL_POOL_MAX` at least 1, `SQL_POOL_IDLE_TIMEOUT` at least 1, `SQL_MAX_ROWS` at least 1, `SQL_POOL_MIN` no more than `SQL_POOL_MAX`), and `LOG_LEVEL` must be a known level. Any invalid value stops the server at startup with a message that names the variable.

## Setting Up the Configuration

1.  **Create your `.env` file:**
    If you don't have a `.env` file, copy the example configuration file:
    ```bash
    cp .env.example .env
    ```

2.  **Edit the `.env` file** to set your specific configuration values:
    ```bash
    nano .env
    ```
    (Or use any other text editor)

## Available Configuration Options

All options are set as environment variables in the `.env` file.

### Database Connection Settings
-   `SQL_SERVER`: SQL Server hostname or IP address (Default: `localhost`)
-   `SQL_PORT`: SQL Server port (Default: `1433`)
-   `SQL_USER`: SQL Server username (Default: `sa`)
-   `SQL_PASSWORD`: SQL Server password (Default: `yourStrong(!)Password`)
-   `SQL_DATABASE`: Default database name (Default: `master`)

### Security Settings
-   `SQL_ENCRYPT`: Whether to encrypt the connection. Any value other than `false` encrypts (Default: `true`)
-   `SQL_TRUST_SERVER_CERTIFICATE` (or `SQL_TRUST_SERVER_CERT`): Whether to trust the server certificate. Only the value `true` trusts it (Default: `false`). Set it to `true` for servers with a self-signed certificate.
-   `SQL_ALLOWED_DATABASES`: A comma-separated list of database names that the MCP server is allowed to access (e.g., `db1,db2,another_db`). If empty or not set, there is no whitelist check: any database the `SQL_USER` login can access may be targeted. When the list is set, 3-part names inside queries (`OtherDb.dbo.Table`) must also name a listed database, and 4-part (linked-server) names are always rejected.
    -   The `database` argument of a tool call is compared with this list case-insensitively, after trimming and removing one layer of `[...]` or `"..."` delimiters from both, so `[Sales]`, `SALES` and ` sales ` all match `Sales`. The server always connects with the name as spelled in this list (or in `SQL_DATABASE` for the default database), never as spelled by the caller, so on a case-sensitive server a differently-cased argument can't reach a different database.
    -   Database names inside a query (3-part names, 3-part function names, `db..object`, and names passed as strings to functions such as `OBJECT_ID`) are resolved by SQL Server, so they must match the spelling in this list exactly, letter case included; only delimiters and trailing spaces are ignored, except in a function argument that is a whole database name (`DB_ID('Sales')`), which must be the bare name exactly as listed. With `Sales` in the list, `SELECT * FROM SALES.dbo.t` is rejected with a `PermissionError` that says to use `[Sales]`.
    -   A database that isn't on the list is rejected with a `PermissionError` before any connection is made. The message says the database is either not on the list or does not exist, and lists the allowed databases.
    -   Without a list, a database that doesn't exist (or that the login can't open) fails with a `ConnectionError` whose message says so, with `code` `ELOGIN` and `sqlErrorNumber` `4060`. Like any rejected login, it is not retried under `SQL_RETRY_MAX_RETRIES`.
    -   After unwrapping, a database name may contain only letters, digits, underscores, hyphens and spaces; anything else (including a leftover `[` or `]`) is a `ValidationError`.
-   `SQL_ALLOWED_PROCEDURES`: A comma-separated list of stored procedures that `execute_stored_procedure` may run (e.g., `dbo.GetOrders,reporting.MonthlyTotals`). Each entry must be schema-qualified, as `schema.proc` or `[schema].[proc]`, with names made of letters, digits and underscores; brackets are stripped and names compare case-insensitively. Entries without a schema (e.g. `GetOrders`) or in another format are ignored with a warning in the log, because SQL Server would resolve an unqualified name against the caller's default schema. Requested names are parsed the same way: they must also be schema-qualified and match an entry exactly. (Default: empty. When no valid entry remains, the `execute_stored_procedure` tool is not registered.)
-   `SQL_MAX_ROWS`: Maximum rows returned per result set (Default: `1000`). `execute_query`'s `limit` defaults to and cannot exceed it; stored procedure result sets are cut off at it.

### Read-Only Guarantees
-   **Single-statement `SELECT` validation:** `execute_query` accepts exactly one `SELECT` (or `WITH ... SELECT`) statement. The query is tokenised with T-SQL string, identifier and comment rules, so a second statement can't be smuggled past the check, and write or control keywords (`INSERT`, `UPDATE`, `DELETE`, `EXEC`, `INTO`, `OPENQUERY`, `WAITFOR`, and so on) are rejected.
-   **Always rolled back:** every query, and every allowed stored procedure call, runs inside a transaction that is rolled back when the call ends, whether it succeeded, failed, stopped early once the page was full, or was cancelled by the client. Actions a transaction can't undo (some system procedures, linked-server calls, `BACKUP`) are not covered by this.
-   **Procedures are allow-list only:** see `SQL_ALLOWED_PROCEDURES` above. The outer rollback does not undo changes a procedure commits itself (its own `COMMIT`, or a `ROLLBACK` followed by further writes), so allow-list only procedures you trust to be read-only.

### Recommended: Read-Only Database Login
The only airtight guarantee is a login that can't write. Use a dedicated login that is a member of `db_datareader`, has `DENY EXECUTE`, and is mapped only into the databases in `SQL_ALLOWED_DATABASES`. If you allow specific procedures, grant `EXECUTE` on just those procedures instead of denying it database-wide. See the README for an example script.

### Connection Timeouts
-   `SQL_CONNECTION_TIMEOUT`: Connection timeout in milliseconds (Default: `15000`)
-   `SQL_REQUEST_TIMEOUT`: Request timeout in milliseconds (Default: `15000`)

### Connection Pool Settings
-   `SQL_POOL_MAX`: Maximum number of connections in the pool (Default: `10`)
-   `SQL_POOL_MIN`: Minimum number of connections in the pool (Default: `0`)
-   `SQL_POOL_IDLE_TIMEOUT`: Idle timeout for connections in the pool in milliseconds (Default: `30000`)

### Retry Settings (for connecting a pool)
Each database's pool connects on first use (the default database's pool also connects in the background at startup), and these settings apply every time a pool connects.
-   `SQL_RETRY_MAX_RETRIES`: Number of connection attempts (Default: `3`; `0` still makes one attempt). A rejected login is not retried.
-   `SQL_RETRY_DELAY_MS`: Initial delay between retry attempts in milliseconds; it doubles after each attempt (Default: `1000`)
-   `SQL_RETRY_MAX_DELAY_MS`: Maximum delay between retry attempts in milliseconds (Default: ten times `SQL_RETRY_DELAY_MS`, i.e. `10000`)

### Caching Settings
-   `CACHE_TTL_MS`: Time-To-Live for the database schema cache in milliseconds (Default: `300000`, i.e., 5 minutes)

### Logging Settings
-   `LOG_LEVEL`: Logging level for the application: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`, case-insensitive (Default: `info`). Logs are written to stderr, because stdout carries the MCP protocol.

### Date and Time Output
Date and time values are returned as their exact SQL text (see "Results and Errors" in the README); there is no setting for this. Keeping the offset of `datetimeoffset` values depends on an internal module of the `tedious` driver (`tedious/lib/value-parser.js`), which the server wraps at startup after a self-check. If the self-check fails, a warning is logged and `datetimeoffset` values are returned as UTC with `+00:00`; at `debug` level the active mode is logged as `datetimeoffsetMode` (`offset-preserved` or `utc-fallback`). Date/time values inside `sql_variant` columns are returned as date-and-time text with trailing fractional zeros removed, because the driver does not report a variant's base type or scale; a variant `datetimeoffset` includes its stored offset, except in `utc-fallback` mode, where it is returned as its UTC time with no offset marker.

## Running Without Docker

The variables must be in the server's environment. Either export them in your shell, or pass the `.env` file to Node:
```bash
npm run build
node --env-file=.env dist/server.js
```
`npm start` (and `npm run dev`, which is the same command) runs `server.ts` from source with `tsx`, using the variables already in your environment.

## Using with Docker Compose

Docker Compose will automatically look for and use the `.env` file in the same directory as the `docker-compose.yml` file (the project root). Only the variables listed under `environment` in `docker-compose.yml` are passed into the container.

Simply run:
```bash
docker-compose up -d
```
To run in detached mode, or:
```bash
docker-compose up --build
```
To rebuild the image and then run.

## Security Note

The `.env` file contains sensitive information, including database credentials.
**Never commit your actual `.env` file to version control.**
The `.env.example` file is provided as a template and *should* be committed to version control. It should contain placeholder or default non-sensitive values.
