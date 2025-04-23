# MCP SQL Server

This is a Model Context Protocol (MCP) server for SQL Server interactions. It allows Large Language Models (LLMs) like Claude to execute SQL queries, explore database schema, and maintain persistent connections across multiple requests.

## Features

- **SQL Query Execution**: Run SELECT queries against SQL Server databases
- **Stored Procedure Support**: Execute stored procedures with parameters
- **Schema Exploration**: View database table and column definitions
- **Session Persistence**: Maintains SQL connections between queries for temporary tables and multi-query operations
- **Docker Ready**: Simple deployment with Docker

## Quick Start

### Using Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/JubinSaniei/mcp-mssql
cd mcp-mssql

# Start the container with your SQL Server connection details
./docker-run.sh 192.168.1.100 YourSecurePassword

# Test the connection and session persistence
./test-mcp.sh
./test-session-persistence.sh
```

For complete Docker setup instructions, see the [Docker README](README.docker.md).

## Configuration

The server supports the following environment variables:

| Category | Variable | Description | Default |
|----------|----------|-------------|---------|
| **Connection** | SQL_SERVER | SQL Server hostname or IP | 172.31.64.1 |
| | SQL_PORT | SQL Server port | 1433 |
| | SQL_USER | SQL Server username | sa |
| | SQL_PASSWORD | SQL Server password | *Required* |
| | SQL_DATABASE | Database name | '' |
| **Security** | SQL_ENCRYPT | Enable encryption | true |
| | SQL_TRUST_SERVER_CERT | Trust server certificate | true |
| **Timeouts** | SQL_CONNECTION_TIMEOUT | Connection timeout (ms) | 30000 |
| | SQL_REQUEST_TIMEOUT | Request timeout (ms) | 30000 |
| **Connection Pool** | SQL_POOL_MAX | Max connections in pool | 10 |
| | SQL_POOL_MIN | Min connections in pool | 0 |
| | SQL_POOL_IDLE_TIMEOUT | Idle timeout for pool (ms) | 30000 |

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

1. Execute queries:
   ```
   <mcp:execute_query>
   SELECT TOP 10 * FROM YourTable
   </mcp:execute_query>
   ```

2. Execute stored procedures:
   ```
   <mcp:execute_StoredProcedure>
   {
     "procedure": "sp_tables",
     "parameters": []
   }
   </mcp:execute_StoredProcedure>
   ```

3. Explore database schema:
   ```
   <mcp:schema>
   YourDatabaseName
   </mcp:schema>
   ```

## Session Persistence

This MCP server implements session persistence for SQL connections, which allows:

- Creating and using temporary tables across multiple queries
- Maintaining variables and session state
- Persistent transactions (though exercise caution with long-running transactions)
- Better performance without reconnecting

The session persistence is handled automatically - Claude will maintain the same database connection throughout a single conversation.

## Development

### Local Development Setup

```bash
# Install dependencies
npm install

# Run the server directly (requires environment variables to be set)
npm start

# Run with TypeScript compiler watching for changes
npm run dev
```

### Testing

```bash
# Test basic query functionality
./test-query.sh

# Test session persistence (requires Docker)
./test-session-persistence.sh
```

## Security Notes

- The server only allows SELECT queries (no INSERT, UPDATE, DELETE, etc.)
- System and extended stored procedures (sp_*, xp_*) are blocked
- SQL injection protection is implemented for database names and parameters

## Troubleshooting

If you encounter issues:

1. Check container logs: `docker logs mssql-mcp`
2. Verify SQL Server connection: `./test-mcp.sh`
3. Test session persistence: `./test-session-persistence.sh`
4. Ensure the SQL_PASSWORD environment variable is correctly set

For detailed troubleshooting steps, see the [Docker README](README.docker.md).