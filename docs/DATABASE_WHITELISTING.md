# Database Whitelisting in MSSQL MCP Server

## Introduction

The MSSQL MCP Server includes a database whitelisting feature designed to enhance security by restricting the set of databases the server can interact with. This is primarily controlled by the `SQL_ALLOWED_DATABASES` environment variable. This document explains how this feature works and clarifies the roles of `SQL_ALLOWED_DATABASES` and the `SQL_DATABASE` environment variables.

## Understanding `SQL_DATABASE` (The Default Database)

The `SQL_DATABASE` environment variable specifies the **default database** that the MSSQL MCP Server connects to upon startup and uses for operations when no specific database is indicated in a request from the Language Model (LLM).

**Key characteristics:**

*   **Initial Connection:** When the server initializes its connection pool, it typically uses the database specified by `SQL_DATABASE` as the context for the initial connections.
*   **Fallback for Operations:** If an LLM sends a request (e.g., `execute_query`, `execute_stored_procedure`, or `schema` resource access) without explicitly naming a target database, the operation is performed against this default `SQL_DATABASE`.
*   **Operational Convenience:** It provides a convenient default, so users don't have to specify the database for every single interaction if they are primarily working with one database.

**Example:**
If `SQL_DATABASE=MyAppDB` is set, and the LLM sends `<mcp:execute_query>SELECT * FROM MyTable</mcp:execute_query>`, the query will be run against the `MyAppDB` database.

## Understanding `SQL_ALLOWED_DATABASES` (The Whitelist)

The `SQL_ALLOWED_DATABASES` environment variable defines an **explicit list of databases** that the MSSQL MCP Server is permitted to interact with. It acts as a security enforcement layer.

**Key characteristics:**

*   **Purpose:** It restricts which databases the server's tools will target and which databases queries may name, on top of the permissions held by the `SQL_USER`. It is enforced by the server's own checks, so it narrows access but does not replace database permissions (see "What it does not cover" below).
*   **Configuration:** It's set as a comma-separated string of database names in your `.env` file (e.g., `SQL_ALLOWED_DATABASES=MyAppDB,ReportingDB,ArchiveDB`).
*   **Enforcement:**
    *   **If `SQL_ALLOWED_DATABASES` is set and is not empty:** Before any database operation (query, stored procedure, schema fetch), the `DatabaseService` checks if the target database (whether it's the default `SQL_DATABASE` or one specified in the LLM's request) is present in this whitelist. If the target database is not in the list, the operation is denied with a permission error.
    *   **If `SQL_ALLOWED_DATABASES` is not set or is an empty string:** `config.ts` sets `allowedDatabases` to an empty array (`[]`). `DatabaseService.ts` only checks the target database when the list has at least one entry, so with an empty list this whitelist check is bypassed. In this scenario, access is primarily governed by the database permissions granted to the `SQL_USER`.
*   **Scope:** The check on the target database applies to all database interaction tools and resources (`execute_query`, `execute_stored_procedure`, `schema`).
*   **Names inside queries:** For `execute_query`, table references are checked as well:
    *   A 3-part name (`OtherDb.dbo.Table`) must name a database in the whitelist, otherwise the query is rejected. This includes 3-part function names (`OtherDb.dbo.fn(...)`, `OtherDb..fn(...)`, `OtherDb.$PARTITION.fn(...)`), which are checked on the query text before it is parsed. `$PARTITION` with a database name is not supported even for an allowed database; use `$PARTITION.fn(...)` in the target database. Without a whitelist, 3-part names are not restricted.
    *   A database name inside the query must be spelled exactly as in the whitelist, letter case included, after removing `[ ]` or `" "` and trailing spaces. With `SQL_ALLOWED_DATABASES=Sales`, `Sales.dbo.t` and `[Sales ].dbo.t` are accepted, but `SALES.dbo.t` and `OBJECT_ID('sales.dbo.t')` are rejected with a message naming the spelling to use (`[Sales]`), because on a case-sensitive server a differently-cased name can be a different database. This applies to 3-part names, 3-part function names, `db..object` and names passed as strings to system functions. A function argument that is a whole database name (`DB_ID('Sales')`, `DATABASEPROPERTYEX`, `HAS_DBACCESS`) must be the bare name exactly as listed: `[ ]`, quotes and spaces are not removed there. The `database` argument of a tool call is still matched case-insensitively (see "Case Sensitivity" below).
    *   A 4-part (linked-server) name (`Server.Db.dbo.Table`) is always rejected.
    *   `OPENQUERY`, `OPENROWSET` and `OPENDATASOURCE` are always rejected.
*   **Indirect references:** When the whitelist is not empty, `execute_query` also rejects these ways of reaching other databases. Without a whitelist, none of them is restricted.
    *   **Names passed as strings to system functions.** The string arguments of `OBJECT_ID`, `COL_LENGTH`, `HAS_PERMS_BY_NAME` and `fn_my_permissions` are read as `[database].[schema].[object]` names. The validator understands `[ ]` with `]]`, `" "` and `db..object`. A database part outside the whitelist is rejected, and so is a 4-part name. For `DB_ID`, `DATABASEPROPERTYEX`, `DATABASEPROPERTY`, `HAS_DBACCESS`, `sys.fn_hadr_is_primary_replica`, `sys.fn_hadr_backup_is_preferred_replica`, `sys.fn_db_backup_file_snapshots`, and `HAS_PERMS_BY_NAME` or `fn_my_permissions` with the `'DATABASE'` class, the whole string is the database name. 1- and 2-part names (`OBJECT_ID('dbo.t')`) and calls without the argument (`DB_ID()`, `DB_NAME()`) are allowed.
    *   **Arguments that cannot be checked.** The name must be a single string literal. A column, variable, expression or concatenation is rejected. A database id (`DB_NAME(id)`, `OBJECT_NAME(id, db_id)`, `OBJECT_SCHEMA_NAME(id, db_id)`) is accepted only as a `DB_ID(...)` call. For example, `COL_LENGTH('dbo.t', 'c')` is accepted, but `COL_LENGTH(t.name, 'c')` is rejected.
    *   **Arguments that only resolve in the current database** are not restricted: the object id of `COLUMNPROPERTY` (e.g. `COLUMNPROPERTY(c.object_id, c.name, 'IsIdentity')`), the file name of `FILEPROPERTY`, and a `NULL` securable in `HAS_PERMS_BY_NAME` or `fn_my_permissions` (the server itself, or the current database for the `DATABASE` class; `fn_my_permissions` also accepts `DEFAULT`), whatever the class argument is. An `OBJECT_ID(...)` call inside them is still checked.
    *   **Server-wide views.** The following views and functions, which show the names, ids, data or query text of other databases, are rejected, including bracketed or quoted spellings such as `[sys].[databases]`:
        *   Catalog and compatibility views: `sys.databases`, `sysdatabases`, `sys.master_files`, `sysaltfiles`, `sysprocesses`, `syslockinfo`, `syscacheobjects`, `sysperfinfo`, `sys.database_mirroring`, `sys.database_mirroring_witnesses`, `sys.database_recovery_status` and `sys.availability_databases_cluster`.
        *   Every `sys.dm_exec_*`, `sys.dm_xe_*`, `sys.dm_tran_*`, `sys.dm_hadr_*`, `sys.dm_fts_*` and `sys.dm_db_missing_index_*` view or function.
        *   `sys.dm_database_encryption_keys`, `sys.dm_db_index_usage_stats`, `sys.dm_db_index_physical_stats`, `sys.dm_db_index_operational_stats`, `sys.dm_db_page_info`, `sys.dm_db_database_page_allocations`, `sys.dm_db_log_info`, `sys.dm_db_log_stats`, `sys.dm_db_mirroring_auto_page_repair`, `sys.dm_io_virtual_file_stats`, `sys.dm_os_buffer_descriptors`, `sys.dm_os_buffer_pool_extension_pages`, `sys.dm_os_performance_counters`, `sys.dm_os_volume_stats`, `sys.dm_os_waiting_tasks`, `sys.dm_broker_activated_tasks`, `sys.dm_broker_queue_monitors`, `sys.dm_clr_appdomains`, `sys.dm_qn_subscriptions` and `sys.dm_server_suspend_status`.
        *   The functions `sys.fn_virtualfilestats` and `sys.fn_get_sql`.

        Other system views may still show server-wide metadata, including names or ids of other databases; the list above is not exhaustive. Do not grant the `SQL_USER` login `VIEW SERVER STATE` (or `VIEW SERVER PERFORMANCE STATE` on SQL Server 2022 and later), which most of these views require.
    *   **Global temporary tables.** `##name` tables are rejected unless `tempdb` is in the whitelist, because they live in `tempdb` and any session can create or read them.
*   **What it does not cover:**
    *   **Stored procedures.** They are checked only for the database they are executed in. What a procedure reads or touches internally, including other databases, is not inspected, so list only trusted procedures in `SQL_ALLOWED_PROCEDURES`.
    *   **Objects in an allowed database that point at another database.** A synonym, view or function there can read another database. The query only shows the object's own name, so this cannot be detected by reading the query.
    *   **SQL Server permissions.** The whitelist is not a substitute for them. For an airtight boundary, map the `SQL_USER` login only into the allowed databases, and do not grant it `VIEW SERVER STATE` (or `VIEW SERVER PERFORMANCE STATE`), which opens the server-wide dynamic management views.

## Key Differences and How They Work Together

| Feature                 | `SQL_DATABASE`                                  | `SQL_ALLOWED_DATABASES`                                       |
| :---------------------- | :---------------------------------------------- | :------------------------------------------------------------ |
| **Primary Role**        | Operational default database                    | Security whitelist for permitted databases                    |
| **Purpose**             | Convenience, defines initial connection context | Restriction, limits server's scope of database interaction    |
| **Effect if Not Set**   | Falls back to a default in `config.ts` (`master`) | Whitelist check is bypassed; access relies on SQL user permissions |
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
SQL_DATABASE=MyAppDB
SQL_ALLOWED_DATABASES=MyAppDB,SalesDB_ReadOnly,StagingDB
```

**Processing:**

1.  `config.ts` splits `SQL_ALLOWED_DATABASES` on commas, trims each entry and drops empty ones, giving `allowedDatabases`.
2.  `DatabaseService.ts` removes delimiters from each entry once at startup and keys it by its lower-cased name. Before every operation it checks the target database against those keys, and `execute_query` also passes the entries, as spelled in the list, to the query validator, which checks 3-part names and the indirect references listed above. A target database outside the list is rejected with a `PERMISSION_ERROR`; a query naming one is rejected before it is sent to SQL Server.

## Important Considerations

*   **Permissiveness if Unset:** Remember, if `SQL_ALLOWED_DATABASES` is not set or is empty, the whitelist check is bypassed, and the server becomes more permissive, relying on the `SQL_USER`'s database-level permissions.
*   **SQL User Permissions Still Apply:** The whitelist restricts access *further* than what the `SQL_USER` is already permitted. The `SQL_USER` must still have the necessary SQL Server permissions (e.g., `SELECT` on tables, `EXECUTE` on procedures) for the databases that *are* included in the whitelist. The whitelist does not grant any SQL permissions.
*   **Case Sensitivity:** The `database` argument of a tool call is compared with the whitelist case-insensitively, ignoring leading and trailing spaces, and the server then connects with the name as spelled in the whitelist. Database names inside a query must match the whitelist spelling exactly, letter case included (trailing spaces are ignored, leading ones are not), since SQL Server resolves those names itself.

By understanding and correctly configuring both `SQL_DATABASE` and `SQL_ALLOWED_DATABASES`, you can significantly improve the security and control over your MSSQL MCP Server's database interactions.
