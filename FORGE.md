# FORGE.md
> MCP server that gives LLMs secure, read-oriented access to SQL Server databases.

## Stack & Commands
- Language: TypeScript 5.x (ES modules) · Runtime: Node.js (tsx for dev) · SQL driver: mssql · SQL parser: node-sql-parser · Logging: pino
- `npm start` / `npm run dev` — run the MCP server via `tsx server.ts`
- `npm run build` — compile TypeScript to `dist/` via `tsc`
- `npm run lint` — type-check only (`tsc --noEmit`)
- `docker-compose up -d` — run via Docker (production path uses `node entrypoint.mjs` → `dist/server.js`)

## Layout
All source lives at the project root — there are no `src/` subdirectories. `server.ts` is the MCP server entry point (tool/resource registration, transport, lifecycle). `DatabaseService.ts` contains all SQL Server interaction logic (connection pool, query execution, stored procedure execution, schema retrieval). `config.js` reads environment variables into `sqlConfig`. `errors.ts` defines `MssqlMcpError` and the `ErrorType` enum. `types.d.ts` provides ambient type declarations for `config.js`. Documentation lives in `docs/` (Docker setup, config guide, database whitelisting). `claude-mcp-config.json` is the Claude CLI MCP registration config.

## Architecture
Single-process stdio MCP server built on `@modelcontextprotocol/sdk`. The entry point `server.ts` registers two tools (`execute_query`, `execute_stored_procedure`) and one resource (`schema://{database}`), then connects via `StdioServerTransport`. All database operations are delegated to a single `DatabaseService` instance in `DatabaseService.ts`, which manages a global `mssql` connection pool with retry logic and exponential backoff. Queries are parsed by `node-sql-parser` and enforced to be SELECT-only; stored procedures bypass the parser but undergo name-format validation. Schema results are cached in-memory with a configurable TTL (`schemaCacheTTL`). Configuration is centralized in `config.js`, which reads all settings from environment variables with sensible defaults.

## Invariants
- `execute_query` ONLY allows SELECT statements — the SQL is parsed via `node-sql-parser` with `database: 'transactsql'` and every AST node's `.type` must be `'select'`; any other type throws `VALIDATION_ERROR`.
- After AST validation, queries are additionally scanned (lowercased) for `exec `, `execute `, `sp_`, `xp_`, `reconfigure`, and `waitfor delay` — presence of any triggers a block. This is a defense-in-depth check separate from the parser.
- `SQL_ALLOWED_DATABASES` whitelist is enforced at the start of `executeQuery`, `executeStoredProcedure`, and `getSchema` — if the list is non-empty and the target database is not in it, a `PERMISSION_ERROR` is thrown before any SQL executes.
- Database context switching uses `USE [dbName]` with bracket-stripping (`replace(/\]/g, '').replace(/\[/g, '')`) — the database name regex allows only `[a-zA-Z0-9_\-\s\[\]]`. Any name not matching this regex is rejected.
- `types.d.ts` declares the shape of `config.js` exports for TypeScript — it MUST stay in sync with `config.js` when new config fields are added (currently out of sync: `types.d.ts` is missing `maxRetries`, `initialRetryDelay`, `maxRetryDelay`, `schemaCacheTTL`, `allowedDatabases`, `logLevel`).
- Connection pool errors trigger automatic `closePool()` + `getPool()` reconnection within each operation's catch handler, but the original operation still returns the initial error — it does NOT retry the user's query/procedure.
- No session state is preserved across MCP calls — each tool invocation may use a different underlying connection from the pool. Temp tables or session variables from one call are not available in the next.
- Pino logger writes to **stderr** (`pino.destination(2)`) so it does not interfere with the stdio MCP transport on stdout.

## Conventions
- ESM throughout: use `.js` extensions in all import paths (e.g., `'./DatabaseService.js'`), even when importing `.ts` files — required by `"module": "NodeNext"`.
- `config.js` is plain JavaScript (not TypeScript) with a companion `types.d.ts` for type safety; ambient declarations use `declare module './config.js'`.
- All errors thrown from `DatabaseService` must be `MssqlMcpError` instances — raw errors are wrapped via `MssqlMcpError.fromError()` with an appropriate `ErrorType`.
- Tool handlers in `server.ts` catch all errors and return them as JSON `content` (never throw to the MCP framework) — error responses include `error`, `errorType`, and `details` fields.
- TypeScript strict mode is enabled (`"strict": true` in tsconfig).
- Stored procedure parameter names are normalized: a leading `@` is stripped before passing to `request.input()`.
- Unknown SQL type strings in stored procedure parameters default to `NVarChar` with a warning log — the type map in `DatabaseService` is case-insensitive.
- Environment variable names follow the pattern `SQL_*` for database config, `MCP_*` for server metadata, `LOG_LEVEL` for logging, `CACHE_TTL_MS` for schema cache.