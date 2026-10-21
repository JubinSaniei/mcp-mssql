import { describe, expect, it } from 'vitest';
import sql from 'mssql';
import { ErrorType, MssqlMcpError } from '../errors.js';
import { buildTrustedConnectionString, loadSqlDriver } from '../sqlDriver.js';

const target = {
  driver: 'ODBC Driver 18 for SQL Server',
  server: 'db.local',
  port: 1433,
  database: 'Sales',
  encrypt: true,
  trustServerCertificate: false,
};

async function rejection(promise: Promise<unknown>): Promise<MssqlMcpError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof MssqlMcpError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('buildTrustedConnectionString', () => {
  it('logs in as the Windows account with no user name or password', () => {
    expect(buildTrustedConnectionString(target)).toBe(
      'Driver={ODBC Driver 18 for SQL Server};Trusted_Connection=yes;Encrypt=yes;TrustServerCertificate=no;Server=db.local,1433;Database=Sales'
    );
  });

  it('passes the encryption settings through', () => {
    const text = buildTrustedConnectionString({ ...target, encrypt: false, trustServerCertificate: true });
    expect(text).toContain(';Encrypt=no;TrustServerCertificate=yes;');
  });

  it('leaves the port out for a named instance', () => {
    expect(buildTrustedConnectionString({ ...target, server: 'db.local\\SQL2022' })).toContain(';Server=db.local\\SQL2022;Database=');
  });

  it('quotes values that would otherwise end or change the connection string', () => {
    const text = buildTrustedConnectionString({ ...target, driver: 'Odd}Driver', database: 'A;Trusted_Connection=no' });
    expect(text).toContain('Driver={Odd}}Driver};');
    expect(text).toContain(';Database={A;Trusted_Connection=no}');
  });

  it('puts the security attributes before any value that comes from configuration', () => {
    const text = buildTrustedConnectionString({ ...target, database: 'A;Encrypt=no' });
    expect(text.indexOf('Encrypt=yes')).toBeLessThan(text.indexOf('Database='));
    expect(text.indexOf('TrustServerCertificate=no')).toBeLessThan(text.indexOf('Server='));
  });
});

describe('loadSqlDriver', () => {
  it('uses tedious for SQL logins without loading msnodesqlv8', async () => {
    let imported = false;
    const driver = await loadSqlDriver('sql', 'linux', async () => {
      imported = true;
      return {};
    });
    expect(driver).toBe(sql);
    expect(imported).toBe(false);
  });

  it('refuses Windows authentication on other platforms', async () => {
    const error = await rejection(loadSqlDriver('windows', 'linux', async () => ({ default: sql })));
    expect(error.errorType).toBe(ErrorType.VALIDATION_ERROR);
    expect(error.message).toContain('only supported when the server runs on Windows');
  });

  it('explains how to install msnodesqlv8 when it cannot be loaded', async () => {
    const error = await rejection(loadSqlDriver('windows', 'win32', async () => {
      throw new Error("Cannot find module 'msnodesqlv8'");
    }));
    expect(error.errorType).toBe(ErrorType.VALIDATION_ERROR);
    expect(error.message).toContain('msnodesqlv8');
    expect(error.message).toContain("Cannot find module 'msnodesqlv8'");
  });

  it('rejects a module that does not provide the driver classes', async () => {
    const error = await rejection(loadSqlDriver('windows', 'win32', async () => ({ default: {} })));
    expect(error.errorType).toBe(ErrorType.VALIDATION_ERROR);
  });

  it('returns the msnodesqlv8 driver module on Windows', async () => {
    const fake = { ConnectionPool: class {}, Transaction: class {}, Request: class {} };
    expect(await loadSqlDriver('windows', 'win32', async () => ({ default: fake }))).toBe(fake);
  });
});
