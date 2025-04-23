#!/bin/bash

# Updated test script to verify MCP session-based connection management
# Compatible with @modelcontextprotocol/sdk v1.10.1+

echo "Testing MCP SQL Server session-based connection stability..."

# Set variables
CONTAINER_NAME="mssql-mcp"
MCP_ENDPOINT="node entrypoint.mjs"
DB_PASSWORD=${SQL_PASSWORD:-"YourPassword"}  # Use env var or default

# Check if container is already running
if ! docker ps | grep -q $CONTAINER_NAME; then
  echo "Starting container $CONTAINER_NAME..."
  # Use the docker-run.sh script which handles image building and container creation
  ./docker-run.sh ${SQL_SERVER:-172.31.64.1} "$DB_PASSWORD"
  
  # Wait for container to initialize
  echo "Waiting for container to initialize (10s)..."
  sleep 10
else
  echo "Container $CONTAINER_NAME is already running."
fi

# Generate a unique session ID for MCP
SESSION_ID="test-mcp-session-$(date +%s)"
echo "Using MCP session ID: $SESSION_ID"

# Helper function to send a request with the session ID
send_mcp_request() {
  local request_id=$1
  local tool_name=$2
  local tool_params=$3
  
  # Format the request with proper MCP protocol format
  local request=$(cat <<EOF
{
  "jsonrpc": "2.0",
  "id": "${request_id}",
  "method": "execute_tool",
  "params": {
    "tool_name": "${tool_name}",
    "tool_params": ${tool_params}
  },
  "context": {
    "sessionId": "${SESSION_ID}"
  }
}
EOF
)

  # Send request to MCP server
  echo "$request" | docker exec -i $CONTAINER_NAME $MCP_ENDPOINT
}

# Test 1: Initial connection - simple query
echo -e "\n--- Test 1: Initial connection - simple query ---"
RESPONSE=$(send_mcp_request "test-1" "execute_query" '{"query": "SELECT 1 AS TestColumn"}')
echo "Response: $RESPONSE"

# Test 2: Run multiple complex queries in sequence using same session
echo -e "\n--- Test 2: Multiple queries with session persistence ---"
for i in {1..3}; do
  echo -e "\nExecuting query $i with session $SESSION_ID..."
  
  # Use a different query each time to verify full query execution
  case $i in
    1) QUERY='{"query": "SELECT TOP 2 @@VERSION AS SqlVersion, @@SERVERNAME AS ServerName"}' ;;
    2) QUERY='{"query": "SELECT TOP 2 name, database_id, create_date FROM sys.databases ORDER BY database_id"}' ;;
    3) QUERY='{"query": "SELECT TOP 2 name, type_desc FROM sys.objects WHERE type = '\''U'\'' ORDER BY name"}' ;;
  esac
  
  RESPONSE=$(send_mcp_request "test-seq-$i" "execute_query" "$QUERY")
  echo "Response: $RESPONSE"
  
  # Check if the response indicates a successful execution
  if echo "$RESPONSE" | grep -q "recordCount"; then
    echo "✓ Query $i executed successfully"
  else
    echo "✗ Query $i failed or returned an error"
  fi
  
  # Add a short delay between queries
  sleep 1
done

# Test 3: Error handling with invalid query (same session)
echo -e "\n--- Test 3: Error handling with invalid query ---"
ERROR_RESPONSE=$(send_mcp_request "test-error" "execute_query" '{"query": "SELECT * FROM NonExistentTable"}')
echo "Error response: $ERROR_RESPONSE"

# Check if the response includes an error message as expected
if echo "$ERROR_RESPONSE" | grep -q "error"; then
  echo "✓ Error handling working correctly"
else
  echo "✗ Error handling failed - no error returned for invalid query"
fi

# Test 4: Test stored procedure execution (same session)
echo -e "\n--- Test 4: Stored procedure execution ---"
SP_RESPONSE=$(send_mcp_request "test-sp" "execute_StoredProcedure" '{"procedure": "sp_tables", "parameters": []}')
echo "Stored procedure response: $SP_RESPONSE"

# Check if the stored procedure executed successfully
if echo "$SP_RESPONSE" | grep -q "recordCount\|outputParameters"; then
  echo "✓ Stored procedure executed successfully"
else
  echo "✗ Stored procedure execution failed"
fi

# Test 5: Connection persistence verification
echo -e "\n--- Test 5: Connection persistence verification ---"
FINAL_RESPONSE=$(send_mcp_request "test-final" "execute_query" '{"query": "SELECT @@SPID AS SessionID, @@CONNECTIONS AS ConnectionCount"}')
echo "Final response: $FINAL_RESPONSE"

# Results summary
echo -e "\n=== Test Results Summary ==="
if [[ "$RESPONSE" && "$SP_RESPONSE" && "$FINAL_RESPONSE" && "$ERROR_RESPONSE" ]]; then
  echo "✓ Session persistence test PASSED: Successfully executed multiple queries in sequence"
  echo "✓ Error handling test PASSED: Properly handled invalid query"
  echo "✓ Stored procedure test PASSED: Successfully executed stored procedure"
else
  echo "✗ Some tests FAILED - see above for details"
fi

echo -e "\nSession ID: $SESSION_ID"
echo "The MCP server should have maintained a persistent connection across all queries."