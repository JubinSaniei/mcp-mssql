# Using the `docker-run.sh` Script

This document explains how to use the `docker-run.sh` script to easily build and run the MSSQL MCP Server Docker container with custom configurations.

## Purpose

The `docker-run.sh` script provides a convenient way to:
- Set common SQL Server connection parameters directly via command-line arguments.
- Override any default configuration by setting environment variables before running the script.
- Automatically remove any existing container with the same name (`mssql-mcp` by default).
- Build the Docker image (`mssql-mcp`) if it doesn't already exist.
- Start a new container with the specified environment variables.

This script is an alternative to using `docker-compose.yml` or manually crafting long `docker run` commands, especially useful for quick deployments or testing with varied configurations.

## Prerequisites

- Docker must be installed and running on your system.
- You need to have the project files, including `docker-run.sh` and the `Dockerfile`.
- The script must have execute permissions: `chmod +x docker-run.sh`.

## Basic Usage

To run the script with default settings (as defined within the script itself, which align with `config.js` defaults):

```bash
./docker-run.sh
```

This will typically attempt to connect to `localhost` with user `sa` and password `yourStrong(!)Password` for the `master` database.

## Usage with Command-Line Arguments

The script accepts two optional positional arguments to quickly set the SQL Server host and password:

```bash
./docker-run.sh [SQL_SERVER_IP_OR_HOSTNAME] [SQL_SERVER_PASSWORD]
```

**Examples:**

-   To connect to a SQL Server at `192.168.1.100` with password `MySecureP@ss`:
    ```bash
    ./docker-run.sh 192.168.1.100 MySecureP@ss
    ```

-   To use the default server but specify a password:
    ```bash
    ./docker-run.sh localhost MySecureP@ss
    # Or, if localhost is the first default in the script:
    # ./docker-run.sh "" MySecureP@ss (though explicitly stating localhost is clearer)
    ```

## Advanced Configuration via Environment Variables

The `docker-run.sh` script is designed to pick up environment variables you set in your shell *before* running it. This allows you to override any of the default values defined within the script.

**How it works:**
The script uses parameter expansion like `${VARIABLE_NAME:-default_value}`. If `VARIABLE_NAME` is already set in your environment, its value will be used; otherwise, the `default_value` from the script is applied.

**Example:**
To run the container with a specific database, a different log level, and a custom container name:

```bash
export SQL_DATABASE="MyApplicationDB"
export LOG_LEVEL="debug"
export CONTAINER_NAME="my-custom-mssql-mcp"
./docker-run.sh <your_sql_server_ip> <your_sql_password>
# Unset them afterwards if you don't want them in your session
# unset SQL_DATABASE LOG_LEVEL CONTAINER_NAME
```

Or, set them for a single command:
```bash
SQL_DATABASE="MyApplicationDB" LOG_LEVEL="debug" CONTAINER_NAME="my-custom-mssql-mcp" ./docker-run.sh <your_sql_server_ip> <your_sql_password>
```

### Key Configurable Variables

You can override any of the variables defined at the top of the `docker-run.sh` script. These include:

-   `SQL_SERVER`
-   `SQL_PORT`
-   `SQL_USER`
-   `SQL_PASSWORD`
-   `SQL_DATABASE`
-   `SQL_ENCRYPT`
-   `SQL_TRUST_SERVER_CERTIFICATE`
-   `SQL_CONNECTION_TIMEOUT`
-   `SQL_REQUEST_TIMEOUT`
-   `SQL_POOL_MAX`
-   `SQL_POOL_MIN`
-   `SQL_POOL_IDLE_TIMEOUT`
-   `SQL_RETRY_MAX_RETRIES`
-   `SQL_RETRY_DELAY_MS`
-   `SQL_RETRY_MAX_DELAY_MS`
-   `CACHE_TTL_MS`
-   `SQL_ALLOWED_DATABASES` (comma-separated list, e.g., "db1,db2")
-   `LOG_LEVEL`
-   `CONTAINER_NAME`

For a complete list and detailed explanation of what each variable does, please refer to the `CONFIG.MD` document.

## What the Script Does

1.  **Sets Configuration**: It determines the values for various SQL Server and application settings based on (in order of precedence):
    1.  Environment variables already set in your shell.
    2.  Positional arguments (`$1` for `SQL_SERVER`, `$2` for `SQL_PASSWORD`).
    3.  Default values defined within the script.
2.  **Stops and Removes Existing Container**: If a Docker container with the target name (default: `mssql-mcp`) already exists, it is stopped and removed (`docker rm -f`).
3.  **Builds Image (if necessary)**: It checks if the Docker image `mssql-mcp` exists. If not, it builds it using `docker build -t mssql-mcp .` from the current directory (which should be the project root containing the `Dockerfile`).
4.  **Runs New Container**: It starts a new Docker container in detached mode (`-d`) with the chosen name and passes all the configured variables as environment variables (`-e`) to the container.
5.  **Outputs Information**: It prints the main connection details and the container name.

## Checking Logs

After the script starts the container, you can view the server logs using:

```bash
docker logs <CONTAINER_NAME>
```

For example, if using the default container name:
```bash
docker logs mssql-mcp
```

To follow the logs in real-time:
```bash
docker logs -f mssql-mcp
```
