import sql from 'mssql';
import type { AuthenticationMode } from './config.js';
import { ErrorType, MssqlMcpError } from './errors.js';

/** The mssql classes DatabaseService constructs; the tedious and msnodesqlv8 modules both export them. */
export type SqlDriver = Pick<typeof sql, 'ConnectionPool' | 'Transaction' | 'Request'>;

export interface TrustedConnectionTarget {
  /** ODBC driver name, e.g. "ODBC Driver 18 for SQL Server". */
  driver: string;
  server: string;
  port: number;
  database: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

/** An ODBC attribute value in braces, with closing braces doubled. */
function braced(value: string): string {
  return `{${value.replace(/}/g, '}}')}}`;
}

/** An ODBC attribute value, braced when it holds characters that would end or change the connection string. */
function odbcValue(value: string): string {
  return /[;{}=]|^\s|\s$/.test(value) ? braced(value) : value;
}

/**
 * Builds the ODBC connection string for Windows authentication. The login is the Windows
 * account running this process (Trusted_Connection), so no user name or password is sent.
 * A named instance (`host\instance`) is found through SQL Server Browser, so it gets no port.
 * ODBC keeps the first occurrence of a keyword, so the fixed security attributes come before
 * the server and database values.
 */
export function buildTrustedConnectionString(target: TrustedConnectionTarget): string {
  const server = target.server.includes('\\') ? target.server : `${target.server},${target.port}`;
  return [
    `Driver=${braced(target.driver)}`,
    'Trusted_Connection=yes',
    `Encrypt=${target.encrypt ? 'yes' : 'no'}`,
    `TrustServerCertificate=${target.trustServerCertificate ? 'yes' : 'no'}`,
    `Server=${odbcValue(server)}`,
    `Database=${odbcValue(target.database)}`,
  ].join(';');
}

function isSqlDriver(value: unknown): value is SqlDriver {
  if (value === null || typeof value !== 'object') return false;
  const { ConnectionPool, Transaction, Request } = value as Record<string, unknown>;
  return typeof ConnectionPool === 'function' && typeof Transaction === 'function' && typeof Request === 'function';
}

const importMsnodesqlv8 = () => import('mssql/msnodesqlv8.js');

/**
 * Returns the mssql driver for the authentication mode: tedious for SQL logins, msnodesqlv8
 * for Windows authentication. msnodesqlv8 is an optional, Windows-only dependency; loading it
 * makes it the driver behind every pool in this process. Throws a VALIDATION_ERROR saying
 * what is missing when Windows authentication cannot be used.
 */
export async function loadSqlDriver(
  authentication: AuthenticationMode,
  platform: NodeJS.Platform = process.platform,
  importDriver: () => Promise<unknown> = importMsnodesqlv8
): Promise<SqlDriver> {
  if (authentication === 'sql') return sql;

  if (platform !== 'win32') {
    throw new MssqlMcpError('SQL_AUTH=windows is only supported when the server runs on Windows.', ErrorType.VALIDATION_ERROR);
  }

  let loaded: unknown;
  try {
    loaded = await importDriver();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MssqlMcpError(
      `SQL_AUTH=windows needs the optional msnodesqlv8 package, which could not be loaded: ${reason}. Run "npm install" on Windows.`,
      ErrorType.VALIDATION_ERROR,
      error instanceof Error ? error : undefined
    );
  }

  const driver = loaded !== null && typeof loaded === 'object' && 'default' in loaded ? loaded.default : loaded;
  if (!isSqlDriver(driver)) {
    throw new MssqlMcpError('The mssql msnodesqlv8 driver module does not export ConnectionPool, Transaction and Request.', ErrorType.VALIDATION_ERROR);
  }
  return driver;
}
