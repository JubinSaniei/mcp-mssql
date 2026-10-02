# Docker Setup for MCP SQL Server

This document provides instructions for running the MSSQL MCP Server application using Docker.

## Prerequisites

- Docker Engine 20.10.0 or newer
- An existing SQL Server instance that the MCP server can connect to

## Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/JubinSaniei/mcp-mssql # Or your repository URL
   cd mcp-mssql
   ```

2. Run the container using the provided script with your SQL Server details:
   ```bash
   # Basic usage (uses the default SQL Server settings in docker-run.sh)
   ./docker-run.sh

   # Specify SQL Server and password
   ./docker-run.sh 192.168.1.100 MySecurePassword123
   ```
   For more details on using this script, see [USING_DOCKER_RUN.md](USING_DOCKER_RUN.md).

3. The MCP server is now ready to be used with Claude through the MCP protocol. Clients start it inside the running container with `docker exec -i mssql-mcp node dist/server.js` (see `claude-mcp-config.json`).

## Environment Variables

The server is configured using environment variables. These can be set in your shell before running `./docker-run.sh`, or by modifying the defaults within `./docker-run.sh` itself, or by using a `.env` file with `docker-compose.yml`.
For a comprehensive guide to all configuration options, refer to [CONFIG.md](CONFIG.md).

The following table summarizes key environment variables. The defaults are those of `config.ts`, which apply when a variable is unset or empty; `docker-run.sh` sets its own defaults for every variable it passes, which match except where noted.

| Category             | Variable                         | Description                                                                 | Default (from config.ts) |
|----------------------|----------------------------------|-----------------------------------------------------------------------------|--------------------------|
| **Connection**       | `SQL_SERVER`                     | SQL Server hostname or IP                                                   | `localhost`              |
|                      | `SQL_PORT`                       | SQL Server port                                                             | `1433`                   |
|                      | `SQL_USER`                       | SQL Server username                                                         | `sa`                     |
|                      | `SQL_PASSWORD`                   | SQL Server password                                                         | `yourStrong(!)Password`  |
|                      | `SQL_DATABASE`                   | Default database name to connect to                                         | `master`                 |
| **Security**         | `SQL_ENCRYPT`                    | Encrypt the connection; only `false` disables it                            | `true` (`docker-run.sh`: `false`) |
|                      | `SQL_TRUST_SERVER_CERTIFICATE`   | Trust the server certificate; only `true` enables it (`SQL_TRUST_SERVER_CERT` also works, and is the name `docker-compose.yml` passes) | `false` (`docker-run.sh`: `true`) |
|                      | `SQL_ALLOWED_DATABASES`          | Comma-separated list of DBs the server can access. Empty means no whitelist check (the login's permissions apply). | `""` (empty string)    |
|                      | `SQL_ALLOWED_PROCEDURES`         | Comma-separated `schema.proc` names `execute_stored_procedure` may run. Empty means the tool is not registered. | `""` (empty string)    |
| **Results**          | `SQL_MAX_ROWS`                   | Maximum rows returned per result set. | `1000`                   |
| **Timeouts & Retries** | `SQL_CONNECTION_TIMEOUT`         | Connection timeout (ms)                                                     | `15000`                  |
|                      | `SQL_REQUEST_TIMEOUT`            | Request timeout for queries (ms)                                            | `15000`                  |
|                      | `SQL_RETRY_MAX_RETRIES`          | Number of connection attempts; `0` still makes one attempt                  | `3`                      |
|                      | `SQL_RETRY_DELAY_MS`             | Initial delay (ms) for connection retries                                   | `1000`                   |
|                      | `SQL_RETRY_MAX_DELAY_MS`         | Max delay (ms) for connection retries                                       | `10000`                  |
| **Connection Pool**  | `SQL_POOL_MAX`                   | Max connections in pool                                                     | `10`                     |
|                      | `SQL_POOL_MIN`                   | Min connections in pool                                                     | `0`                      |
|                      | `SQL_POOL_IDLE_TIMEOUT`          | Idle timeout for connections in pool (ms)                                   | `30000`                  |
| **Caching**          | `CACHE_TTL_MS`                   | Time-To-Live for schema cache (ms)                                          | `300000` (5 minutes)     |
| **Logging**          | `LOG_LEVEL`                      | Log level (e.g., `trace`, `debug`, `info`, `warn`, `error`, `fatal`)        | `info`                   |

## Running with Docker Compose

You can also use Docker Compose to run the service:

```bash
# Set any environment variables or use defaults
export SQL_SERVER=192.168.1.100
export SQL_PASSWORD=MySecurePassword123

# Start the service
docker-compose up -d
```

## Container Structure

The application consists of one container:

- **mssql-mcp**: Node.js application serving the MCP API that connects to your external SQL Server

## Logging

To view logs from the container (default container name is `mssql-mcp`):

```bash
# View logs
docker logs mssql-mcp

# Follow logs
docker logs -f mssql-mcp
```

## Connections and Session State

The container's command (`node dist/server.js`) speaks MCP over stdio and shuts down when its stdin closes, so `docker-run.sh` starts the container with `-i` and `docker-compose.yml` sets `stdin_open: true` to keep it running.

Each server process keeps one connection pool per database, created on first use and reused by later calls; a pool whose connection is lost is replaced on the next call. There are no persistent sessions: every call runs in its own transaction, which is always rolled back, on whichever pooled connection is free. Temporary tables and session settings do not carry over from one call to the next.

## Stopping the Application

```bash
# Stop the container (default name mssql-mcp)
docker stop mssql-mcp

# Remove the container
docker rm mssql-mcp
```

## Troubleshooting

### SQL Server Connection Issues

If the MCP server can't connect to SQL Server:

1. Check that your SQL Server is running and accessible from the Docker network.
2. Use `./docker-run.sh` with explicit parameters: `./docker-run.sh <server-ip> <password>`. For more details on using this script, see [USING_DOCKER_RUN.md](USING_DOCKER_RUN.md).
3. Check if firewall rules are blocking connections to your SQL Server.
4. If SQL Server is on the same host as Docker, you might need to use the host's IP address instead of 'localhost' (Docker networking can vary).

### Queries Fail After the First One

1. Check logs for any connection errors: `docker logs mssql-mcp | grep -i "connect"`.
2. Verify that the SQL Server connection is stable and not timing out.
3. Remember that each call is independent: a query cannot use a temporary table or variable created by an earlier call.

### Container Exits Right After Starting

The server stops when its stdin closes. Start the container with `-i` (`docker-run.sh` does) or `stdin_open: true` (`docker-compose.yml` does).

### MCP Server Issues

If the MCP server fails to start:

1. Check its logs: `docker logs mssql-mcp`
2. Review environment variables being passed to the container
3. Try rebuilding the image: `docker build -t mssql-mcp .`