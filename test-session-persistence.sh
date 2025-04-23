#!/bin/bash

# Session Persistence Test Script for MCP SQL Server
# This script verifies the connection is maintained across multiple separate requests,
# simulating Claude's behavior of making individual requests during a conversation.

echo "Testing MCP SQL Server session persistence across multiple requests..."

# Set variables
CONTAINER_NAME="mssql-mcp"
MCP_ENDPOINT="node entrypoint.mjs"
DB_PASSWORD=${SQL_PASSWORD:-"YourPassword"}  # Use env var or default

# Check container status
if ! docker ps | grep -q $CONTAINER_NAME; then
  echo "Container $CONTAINER_NAME is not running."
  echo "Starting it using docker-run.sh..."
  ./docker-run.sh ${SQL_SERVER:-172.31.64.1} "$DB_PASSWORD"
  
  # Wait for container to initialize
  echo "Waiting for container to initialize (10s)..."
  sleep 10
else
  echo "Container $CONTAINER_NAME is already running."
fi

# Generate a test session ID that will be reused across all requests
SESSION_ID="test-persistence-$(date +%s)"
echo "Using persistent session ID: $SESSION_ID"

# Helper function to send a request with the same session ID
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

  # Send request and capture response
  echo "$request" | docker exec -i $CONTAINER_NAME $MCP_ENDPOINT
}

# Request 1: Create a temporary table
echo -e "\n=== Request 1: Creating a temporary table ==="
CREATE_TEMP_TABLE=$(cat <<EOF
{
  "query": "
    IF OBJECT_ID('tempdb..#SessionTest') IS NOT NULL
      DROP TABLE #SessionTest;
    CREATE TABLE #SessionTest (
      Id INT IDENTITY(1,1) PRIMARY KEY,
      SessionId VARCHAR(50),
      Request VARCHAR(50),
      CreatedAt DATETIME DEFAULT GETDATE()
    );
    INSERT INTO #SessionTest (SessionId, Request)
    VALUES ('${SESSION_ID}', 'Request 1');
    SELECT * FROM #SessionTest;
  "
}
EOF
)
R1_RESPONSE=$(send_mcp_request "req-1" "execute_query" "$CREATE_TEMP_TABLE")
echo "Response: $R1_RESPONSE"

# Simulate delay between requests (as would happen in a real Claude conversation)
echo -e "\nWaiting 5 seconds before next request (simulating conversation delay)..."
sleep 5

# Request 2: Verify the temp table still exists and add a row
echo -e "\n=== Request 2: Verifying temp table persistence ==="
VERIFY_TEMP_TABLE=$(cat <<EOF
{
  "query": "
    -- This will fail if connection was not persisted, as temp tables only exist in the same connection
    INSERT INTO #SessionTest (SessionId, Request)
    VALUES ('${SESSION_ID}', 'Request 2');
    SELECT * FROM #SessionTest ORDER BY Id;
  "
}
EOF
)
R2_RESPONSE=$(send_mcp_request "req-2" "execute_query" "$VERIFY_TEMP_TABLE")
echo "Response: $R2_RESPONSE"

# Simulate another delay
echo -e "\nWaiting 5 seconds before next request (simulating conversation delay)..."
sleep 5

# Request 3: Final verification with SPID check
echo -e "\n=== Request 3: Final verification with SPID check ==="
FINAL_CHECK=$(cat <<EOF
{
  "query": "
    -- Add one more record to the temp table
    INSERT INTO #SessionTest (SessionId, Request)
    VALUES ('${SESSION_ID}', 'Request 3');
    
    -- Return all records and the connection ID (SPID)
    SELECT 
      @@SPID AS ServerProcessID,
      (SELECT COUNT(*) FROM #SessionTest) AS TotalRows,
      * 
    FROM #SessionTest
    ORDER BY Id;
  "
}
EOF
)
R3_RESPONSE=$(send_mcp_request "req-3" "execute_query" "$FINAL_CHECK")
echo "Response: $R3_RESPONSE"

# Parse results to verify
echo -e "\n=== Test Results ==="

# Check if all three requests produced valid responses
if [[ "$R1_RESPONSE" == *"recordCount"* && "$R2_RESPONSE" == *"recordCount"* && "$R3_RESPONSE" == *"recordCount"* ]]; then
  if [[ "$R3_RESPONSE" == *"Request 1"* && "$R3_RESPONSE" == *"Request 2"* && "$R3_RESPONSE" == *"Request 3"* ]]; then
    echo "✅ SESSION PERSISTENCE TEST PASSED!"
    echo "The connection was successfully maintained across all three separate requests."
    echo "Temporary table (#SessionTest) was accessible across all requests, proving session persistence."
  else
    echo "❌ SESSION PERSISTENCE TEST FAILED!"
    echo "The responses do not contain the expected data from previous requests."
  fi
else
  echo "❌ SESSION PERSISTENCE TEST FAILED!"
  echo "One or more requests failed to return a valid response."
fi

echo -e "\nTechnical Details:"
echo "Session ID: $SESSION_ID"
echo "These tests validate that our MCP server maintains SQL Server connections between separate requests."
echo "This is critical for Claude to perform complex multi-query operations during a conversation."