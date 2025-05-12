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
   # Basic usage (uses default SQL Server settings from ../docker-run.sh)
   ../docker-run.sh

   # Specify SQL Server and password
   ../docker-run.sh 192.168.1.100 MySecurePassword123
   ```
   For more details on using this script, see [USING_DOCKER_RUN.md](USING_DOCKER_RUN.md).

3. The MCP server is now ready to be used with Claude through the MCP protocol.

## Environment Variables

The server is configured using environment variables. These can be set in your shell before running `../docker-run.sh`, or by modifying the defaults within `../docker-run.sh` itself, or by using a `.env` file with `docker-compose.yml`.
For a comprehensive guide to all configuration options, refer to [CONFIG.md](CONFIG.md).

The following table summarizes key environment variables and their defaults as per `config.js`:

| Category             | Variable                         | Description                                                                 | Default (from config.js) |
|----------------------|----------------------------------|-----------------------------------------------------------------------------|--------------------------|
| **Connection**       | `SQL_SERVER`                     | SQL Server hostname or IP                                                   | `localhost`              |
|                      | `SQL_PORT`                       | SQL Server port                                                             | `1433`                   |
|                      | `SQL_USER`                       | SQL Server username                                                         | `sa`                     |
|                      | `SQL_PASSWORD`                   | SQL Server password                                                         | `yourStrong(!)Password`  |
|                      | `SQL_DATABASE`                   | Default database name to connect to                                         | `master`                 |
| **Security**         | `SQL_ENCRYPT`                    | Enable encryption (`true`/`false`)                                          | `false`                  |
|                      | `SQL_TRUST_SERVER_CERTIFICATE`   | Trust server certificate (`true`/`false`)                                   | `true`                   |
|                      | `SQL_ALLOWED_DATABASES`          | Comma-separated list of DBs server can access. Empty means `SQL_DATABASE` only or less restricted. | `\"\"` (empty string)    |
| **Timeouts & Retries** | `SQL_CONNECTION_TIMEOUT`         | Connection timeout (ms)                                                     | `15000`                  |
|                      | `SQL_REQUEST_TIMEOUT`            | Request timeout for queries (ms)                                            | `15000`                  |
|                      | `SQL_RETRY_MAX_RETRIES`          | Max retries for initial connection                                          | `3`                      |
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

## Session Management

This container implements persistent session management for SQL connections, which is critical for Claude to perform multiple queries during a conversation. The implementation:

1. Maintains a persistent SQL connection identified by a session ID
2. Automatically reconnects if disconnected
3. Performs regular connection health checks
4. Preserves temporary tables and session state between queries

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
2. Use `../docker-run.sh` with explicit parameters: `../docker-run.sh <server-ip> <password>`. For more details on using this script, see [USING_DOCKER_RUN.md](USING_DOCKER_RUN.md).
3. Check if firewall rules are blocking connections to your SQL Server.
4. If SQL Server is on the same host as Docker, you might need to use the host's IP address instead of 'localhost' (Docker networking can vary).

### Session Persistence Issues

If queries fail after the first one:

1. Check logs for any connection errors: `docker logs mssql-mcp | grep "connection"`.
2. Verify that the SQL Server connection is stable and not timing out.

### MCP Server Issues

If the MCP server fails to start:

1. Check its logs: `docker logs mssql-mcp`
2. Review environment variables being passed to the container
3. Try rebuilding the image: `docker build -t mssql-mcp .`