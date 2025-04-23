#!/bin/bash

# One-command Docker run script for MSSQL MCP Server
# Usage: ./docker-run.sh [SQL_SERVER] [SQL_PASSWORD]
#   Example: ./docker-run.sh 192.168.1.100 MySecurePassword123!

# Set defaults from arguments or use built-in defaults
SQL_SERVER=${1:-${SQL_SERVER:-172.31.64.1}}
SQL_PASSWORD=${2:-${SQL_PASSWORD:-StrongPassword123!}}

# Other settings with defaults
SQL_PORT=${SQL_PORT:-1433}
SQL_USER=${SQL_USER:-sa}
SQL_DATABASE=${SQL_DATABASE:-PDICompany_WP}
SQL_ENCRYPT=${SQL_ENCRYPT:-true}
SQL_TRUST_SERVER_CERT=${SQL_TRUST_SERVER_CERT:-true}
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
  -e SQL_TRUST_SERVER_CERT=${SQL_TRUST_SERVER_CERT} \
  -e SQL_CONNECTION_TIMEOUT=30000 \
  -e SQL_REQUEST_TIMEOUT=30000 \
  -e SQL_POOL_MAX=10 \
  -e SQL_POOL_MIN=0 \
  -e SQL_POOL_IDLE_TIMEOUT=30000 \
  -e MCP_SERVER_NAME="MSSQL Server" \
  -e MCP_SERVER_VERSION="1.0.0" \
  mssql-mcp

echo "Container started. Server details:"
echo "SQL Server: ${SQL_SERVER}"
echo "SQL Port: ${SQL_PORT}"
echo "SQL Database: ${SQL_DATABASE}"
echo "Container Name: ${CONTAINER_NAME}"
echo "Run 'docker logs ${CONTAINER_NAME}' to see server output"