# Configuration Guide for MCP SQL Server

This document explains how to configure the MCP SQL Server application.

## Configuration Method

Configuration is managed through a `.env` file, providing a single source of truth for all settings. This file is used by both Docker Compose and when running the application directly.

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
-   `SQL_ENCRYPT`: Whether to encrypt the connection (`true`/`false`) (Default: `false`)
-   `SQL_TRUST_SERVER_CERTIFICATE`: Whether to trust the server certificate (`true`/`false`) (Default: `true`). Set to `false` for production environments with valid, trusted certificates.
-   `SQL_ALLOWED_DATABASES`: A comma-separated list of database names that the MCP server is allowed to access (e.g., `db1,db2,another_db`). If empty or not set, the behavior depends on the server's internal logic (currently, it might allow access to the `SQL_DATABASE` or any database the `SQL_USER` has permissions for if not further restricted in `DatabaseService.ts`).

### Connection Timeouts
-   `SQL_CONNECTION_TIMEOUT`: Connection timeout in milliseconds (Default: `15000`)
-   `SQL_REQUEST_TIMEOUT`: Request timeout in milliseconds (Default: `15000`)

### Connection Pool Settings
-   `SQL_POOL_MAX`: Maximum number of connections in the pool (Default: `10`)
-   `SQL_POOL_MIN`: Minimum number of connections in the pool (Default: `0`)
-   `SQL_POOL_IDLE_TIMEOUT`: Idle timeout for connections in the pool in milliseconds (Default: `30000`)

### Retry Settings (for initial connection)
-   `SQL_RETRY_MAX_RETRIES`: Maximum number of retries for initial connection attempts (Default: `3`)
-   `SQL_RETRY_DELAY_MS`: Initial delay between retry attempts in milliseconds (Default: `1000`)
-   `SQL_RETRY_MAX_DELAY_MS`: Maximum delay between retry attempts in milliseconds (Default: `10000`)

### Caching Settings
-   `CACHE_TTL_MS`: Time-To-Live for the database schema cache in milliseconds (Default: `300000`, i.e., 5 minutes)

### Logging Settings
-   `LOG_LEVEL`: Logging level for the application (e.g., `trace`, `debug`, `info`, `warn`, `error`, `fatal`) (Default: `info`)

## Running Without Docker

When running without Docker, ensure that the `.env` file is in the root directory of the project. The application loads these variables at startup.

To run the application (assuming Node.js and TypeScript tools are installed globally or as project dependencies):
```bash
npm start
```
This command typically uses `ts-node` to run `server.ts` directly, as defined in `package.json`.

## Using with Docker Compose

Docker Compose will automatically look for and use the `.env` file in the same directory as the `docker-compose.yml` file (the project root).

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
