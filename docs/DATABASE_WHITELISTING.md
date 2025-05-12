# Database Whitelisting in MSSQL MCP Server

## Introduction

The MSSQL MCP Server includes a database whitelisting feature designed to enhance security by restricting the set of databases the server can interact with. This is primarily controlled by the `SQL_ALLOWED_DATABASES` environment variable. This document explains how this feature works and clarifies the roles of `SQL_ALLOWED_DATABASES` and the `SQL_DATABASE` environment variables.

## Understanding `SQL_DATABASE` (The Default Database)

The `SQL_DATABASE` environment variable specifies the **default database** that the MSSQL MCP Server connects to upon startup and uses for operations when no specific database is indicated in a request from the Language Model (LLM).

**Key characteristics:**

*   **Initial Connection:** When the server initializes its connection pool, it typically uses the database specified by `SQL_DATABASE` as the context for the initial connections.
*   **Fallback for Operations:** If an LLM sends a request (e.g., `execute_query`, `execute_StoredProcedure`, or `schema` resource access) without explicitly naming a target database, the operation is performed against this default `SQL_DATABASE`.
*   **Operational Convenience:** It provides a convenient default, so users don't have to specify the database for every single interaction if they are primarily working with one database.

**Example:**
If `SQL_DATABASE=PDICompany_WP` is set, and the LLM sends `<mcp:execute_query>SELECT * FROM MyTable</mcp:execute_query>`, the query will be run against the `PDICompany_WP` database.

## Understanding `SQL_ALLOWED_DATABASES` (The Whitelist)

The `SQL_ALLOWED_DATABASES` environment variable defines an **explicit list of databases** that the MSSQL MCP Server is permitted to interact with. It acts as a security enforcement layer.

**Key characteristics:**

*   **Security Boundary:** Its primary purpose is to restrict the server's access to only a pre-approved set of databases, regardless of the permissions held by the `SQL_USER` on the SQL Server instance.
*   **Configuration:** It's set as a comma-separated string of database names in your `.env` file (e.g., `SQL_ALLOWED_DATABASES=PDICompany_WP,ReportingDB,ArchiveDB`).
*   **Enforcement:**
    *   **If `SQL_ALLOWED_DATABASES` is set and is not empty:** Before any database operation (query, stored procedure, schema fetch), the `DatabaseService` checks if the target database (whether it's the default `SQL_DATABASE` or one specified in the LLM's request) is present in this whitelist. If the target database is not in the list, the operation is denied with a permission error.
    *   **If `SQL_ALLOWED_DATABASES` is not set or is an empty string:** The `config.js` file initializes `sqlConfig.allowedDatabases` as an empty array (`[]`). The permission check logic in `DatabaseService.ts` (`if (this.sqlConfig.allowedDatabases && this.sqlConfig.allowedDatabases.length > 0 && ...)`) means that if this list is empty, this specific whitelist check is bypassed. In this scenario, access is primarily governed by the database permissions granted to the `SQL_USER`.
*   **Scope:** This check applies to all database interaction tools and resources (`execute_query`, `execute_StoredProcedure`, `schema`).

## Key Differences and How They Work Together

| Feature                 | `SQL_DATABASE`                                  | `SQL_ALLOWED_DATABASES`                                       |
| :---------------------- | :---------------------------------------------- | :------------------------------------------------------------ |
| **Primary Role**        | Operational default database                    | Security whitelist for permitted databases                    |
| **Purpose**             | Convenience, defines initial connection context | Restriction, limits server's scope of database interaction    |
| **Effect if Not Set**   | Falls back to a default in `config.js` (`master`) | Whitelist check is bypassed; access relies on SQL user permissions |
| **Interaction**         | Defines *which* database to use by default      | Defines *which* databases are allowed to be used at all       |

**Synergy:**

*   For the server to function as expected when `SQL_ALLOWED_DATABASES` is active (not empty), the database specified in `SQL_DATABASE` **must** also be included in the `SQL_ALLOWED_DATABASES` list.
*   If `SQL_ALLOWED_DATABASES` is set and `SQL_DATABASE` is *not* in that list, the server might be able to establish its initial pool connection (depending on how `mssql` handles it if the default DB is immediately restricted), but subsequent operations targeting the default `SQL_DATABASE` would fail the whitelist check. It's best practice to ensure consistency.

## Why Use Database Whitelisting?

*   **Principle of Least Privilege:** This is a core security concept. The MCP server should only have access to the databases it absolutely needs to perform its functions for the LLM.
*   **Reduced Attack Surface:** By limiting the number of accessible databases, you reduce the potential impact if the MCP server or the `SQL_USER` account were ever compromised.
*   **Prevention of Accidental Access:** It helps prevent LLMs from inadvertently querying or interacting with sensitive or irrelevant databases that the `SQL_USER` might have access to but are not intended for LLM use.
*   **Clearer Security Posture:** It makes the intended scope of the server's database interactions explicit.

## Configuration Example

In your `.env` file:

```properties
SQL_DATABASE=PDICompany_WP
SQL_ALLOWED_DATABASES=PDICompany_WP,SalesDB_ReadOnly,StagingDB
```

**Processing:**

1.  `config.js` reads these environment variables:
    ```javascript
    // Allowed databases
    allowedDatabases: process.env.SQL_ALLOWED_DATABASES 
                      ? process.env.SQL_ALLOWED_DATABASES.split(',').map(db => db.trim()) 
                      : [] // Whitelist of allowed databases
    ```
2.  `DatabaseService.ts` uses `sqlConfig.allowedDatabases` in its methods:
    ```typescript
    // Example from executeQuery
    if (this.sqlConfig.allowedDatabases && 
        this.sqlConfig.allowedDatabases.length > 0 && 
        !this.sqlConfig.allowedDatabases.includes(targetDatabase)) {
      // throw new MssqlMcpError(..., ErrorType.PERMISSION_ERROR, ...);
    }
    ```

## Important Considerations

*   **Permissiveness if Unset:** Remember, if `SQL_ALLOWED_DATABASES` is not set or is empty, the whitelist check is bypassed, and the server becomes more permissive, relying on the `SQL_USER`'s database-level permissions.
*   **SQL User Permissions Still Apply:** The whitelist restricts access *further* than what the `SQL_USER` is already permitted. The `SQL_USER` must still have the necessary SQL Server permissions (e.g., `SELECT` on tables, `EXECUTE` on procedures) for the databases that *are* included in the whitelist. The whitelist does not grant any SQL permissions.
*   **Case Sensitivity:** Database name comparisons are typically case-insensitive in SQL Server by default, but it's good practice to ensure the names in `SQL_ALLOWED_DATABASES` match the case of your actual database names for consistency. The `.trim()` ensures no leading/trailing spaces cause issues.

By understanding and correctly configuring both `SQL_DATABASE` and `SQL_ALLOWED_DATABASES`, you can significantly improve the security and control over your MSSQL MCP Server's database interactions.
