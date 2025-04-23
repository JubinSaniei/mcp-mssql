# Docker Setup for MCP SQL Server

This document provides instructions for running the MSSQL MCP Server application using Docker.

## Prerequisites

- Docker Engine 20.10.0 or newer
- An existing SQL Server instance that the MCP server can connect to

## Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/JubinSaniei/mcp-mssql
   cd mcp-mssql
   ```

2. Run the container using the provided script with your SQL Server details:
   ```bash
   # Basic usage (uses default SQL Server settings)
   ./docker-run.sh

   # Specify SQL Server and password
   ./docker-run.sh 192.168.1.100 MySecurePassword123
   ```

3. Test the connection:
   ```bash
   # Run tests to verify connection and session persistence
   ./test-mcp.sh
   ./test-session-persistence.sh
   ```

4. The MCP server is now ready to be used with Claude through the MCP protocol.

## Environment Variables

The following environment variables can be configured:

| Category | Variable | Description | Default |
|----------|----------|-------------|---------|
| **Connection** | SQL_SERVER | SQL Server hostname or IP | 172.31.64.1 |
| | SQL_PORT | SQL Server port | 1433 |
| | SQL_USER | SQL Server username | sa |
| | SQL_PASSWORD | SQL Server password | StrongPassword123! |
| | SQL_DATABASE | Database name | '' |
| **Security** | SQL_ENCRYPT | Enable encryption | true |
| | SQL_TRUST_SERVER_CERT | Trust server certificate | true |
| **Timeouts** | SQL_CONNECTION_TIMEOUT | Connection timeout (ms) | 30000 |
| | SQL_REQUEST_TIMEOUT | Request timeout (ms) | 30000 |
| **Pool** | SQL_POOL_MAX | Max connections in pool | 10 |
| | SQL_POOL_MIN | Min connections in pool | 0 |
| | SQL_POOL_IDLE_TIMEOUT | Idle timeout for pool (ms) | 30000 |
| **Server** | MCP_SERVER_NAME | MCP server name | "MSSQL Server" |
| | MCP_SERVER_VERSION | MCP server version | "1.0.0" |

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

To view logs from the container:

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
# Stop the container
docker stop mssql-mcp

# Remove the container
docker rm mssql-mcp
```

## Troubleshooting

### SQL Server Connection Issues

If the MCP server can't connect to SQL Server:

1. Check that your SQL Server is running and accessible from the Docker network
2. Use `docker-run.sh` with explicit parameters: `./docker-run.sh <server-ip> <password>`
3. Check if firewall rules are blocking connections to your SQL Server
4. If SQL Server is on the same host as Docker, you might need to use the host's IP instead of 'localhost'

### Session Persistence Issues

If queries fail after the first one:

1. Run the session persistence test: `./test-session-persistence.sh`
2. Check logs for any connection errors: `docker logs mssql-mcp | grep "connection"`
3. Verify that the SQL Server connection is stable and not timing out

### MCP Server Issues

If the MCP server fails to start:

1. Check its logs: `docker logs mssql-mcp`
2. Review environment variables being passed to the container
3. Try rebuilding the image: `docker build -t mssql-mcp .`