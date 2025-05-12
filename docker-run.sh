#!/bin/bash

# One-command Docker run script for MSSQL MCP Server
# Usage: ./docker-run.sh [SQL_SERVER] [SQL_PASSWORD]
#   Example: ./docker-run.sh 192.168.1.100 MySecurePassword123!

# Set defaults from arguments or use built-in defaults
SQL_SERVER=${1:-${SQL_SERVER:-localhost}}
SQL_PASSWORD=${2:-${SQL_PASSWORD:-yourStrong(!)Password}}

# Other settings with defaults - aligned with config.js
SQL_PORT=${SQL_PORT:-1433}
SQL_USER=${SQL_USER:-sa}
SQL_DATABASE=${SQL_DATABASE:-master}
SQL_ENCRYPT=${SQL_ENCRYPT:-false}
SQL_TRUST_SERVER_CERTIFICATE=${SQL_TRUST_SERVER_CERTIFICATE:-true} # Renamed from SQL_TRUST_SERVER_CERT

SQL_CONNECTION_TIMEOUT=${SQL_CONNECTION_TIMEOUT:-15000}
SQL_REQUEST_TIMEOUT=${SQL_REQUEST_TIMEOUT:-15000}

SQL_POOL_MAX=${SQL_POOL_MAX:-10}
SQL_POOL_MIN=${SQL_POOL_MIN:-0}
SQL_POOL_IDLE_TIMEOUT=${SQL_POOL_IDLE_TIMEOUT:-30000}

SQL_RETRY_MAX_RETRIES=${SQL_RETRY_MAX_RETRIES:-3}
SQL_RETRY_DELAY_MS=${SQL_RETRY_DELAY_MS:-1000}
SQL_RETRY_MAX_DELAY_MS=${SQL_RETRY_MAX_DELAY_MS:-10000}

CACHE_TTL_MS=${CACHE_TTL_MS:-300000}
SQL_ALLOWED_DATABASES=${SQL_ALLOWED_DATABASES:-""} # Default to empty string, allowing all if not set
LOG_LEVEL=${LOG_LEVEL:-info}

CONTAINER_NAME=${CONTAINER_NAME:-mssql-mcp}

# Remove existing container if it exists
docker rm -f ${CONTAINER_NAME} 2>/dev/null || true
echo "Starting MSSQL MCP Server container..."

# Build the Docker image if it doesn't exist
if ! docker image inspect mssql-mcp &>/dev/null; then
    echo "Building Docker image..."
    docker build -t mssql-mcp .
fi

# Run container with all environment variables
docker run -d --name ${CONTAINER_NAME} \
  -e SQL_SERVER=${SQL_SERVER} \
  -e SQL_PORT=${SQL_PORT} \
  -e SQL_USER=${SQL_USER} \
  -e SQL_PASSWORD=${SQL_PASSWORD} \
  -e SQL_DATABASE=${SQL_DATABASE} \
  -e SQL_ENCRYPT=${SQL_ENCRYPT} \
  -e SQL_TRUST_SERVER_CERTIFICATE=${SQL_TRUST_SERVER_CERTIFICATE} \
  -e SQL_CONNECTION_TIMEOUT=${SQL_CONNECTION_TIMEOUT} \
  -e SQL_REQUEST_TIMEOUT=${SQL_REQUEST_TIMEOUT} \
  -e SQL_POOL_MAX=${SQL_POOL_MAX} \
  -e SQL_POOL_MIN=${SQL_POOL_MIN} \
  -e SQL_POOL_IDLE_TIMEOUT=${SQL_POOL_IDLE_TIMEOUT} \
  -e SQL_RETRY_MAX_RETRIES=${SQL_RETRY_MAX_RETRIES} \
  -e SQL_RETRY_DELAY_MS=${SQL_RETRY_DELAY_MS} \
  -e SQL_RETRY_MAX_DELAY_MS=${SQL_RETRY_MAX_DELAY_MS} \
  -e CACHE_TTL_MS=${CACHE_TTL_MS} \
  -e SQL_ALLOWED_DATABASES=${SQL_ALLOWED_DATABASES} \
  -e LOG_LEVEL=${LOG_LEVEL} \
  mssql-mcp

echo "Container started. Server details:"
echo "SQL Server: ${SQL_SERVER}"
echo "SQL Port: ${SQL_PORT}"
echo "SQL Database: ${SQL_DATABASE}"
echo "Container Name: ${CONTAINER_NAME}"
echo "Run 'docker logs ${CONTAINER_NAME}' to see server output"