declare module './config.js' {
  export const sqlConfig: {
    server: string;
    port: number;
    user: string;
    password: string;
    database: string;
    options: {
      encrypt: boolean;
      trustServerCertificate: boolean;
    };
    connectionTimeout: number;
    requestTimeout: number;
    pool: {
      max: number;
      min: number;
      idleTimeoutMillis: number;
    };
    maxRetries: number;
    initialRetryDelay: number;
    maxRetryDelay: number;
    schemaCacheTTL: number;
    maxRows: number;
    allowedDatabases: string[];
    logLevel: string;
  };
}

// Augment McpServer with registerTool — exists at runtime in SDK v1.23+ but is
// missing from the published .d.ts type declarations. We use a standalone interface
// and cast to it, because module augmentation still triggers the deep-inference
// bug in the SDK's deprecated tool() overloads (TS2589).
import { type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface McpServerWithRegisterTool extends McpServer {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: (args: any, extra: any) => CallToolResult | Promise<CallToolResult>
  ): any;
}
