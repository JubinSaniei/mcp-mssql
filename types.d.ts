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
  };

  export const mcpConfig: {
    name: string;
    version: string;
    port: number;
  };
}