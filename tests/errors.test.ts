import { describe, expect, it } from 'vitest';
import sql from 'mssql';
import { ErrorType, MssqlMcpError, classifyError, extractDriverErrorInfo, toClientError, toMssqlMcpError } from '../errors.js';

function driverError(name: string, code: string, number?: number): Error {
  const err = new Error(`${name} ${code}`) as Error & { code: string; number?: number };
  err.name = name;
  err.code = code;
  if (number !== undefined) err.number = number;
  return err;
}

describe('classifyError', () => {
  it('reports request timeouts as query timeouts and connect timeouts as connection timeouts', () => {
    expect(classifyError(driverError('RequestError', 'ETIMEOUT'), ErrorType.QUERY_ERROR).errorType).toBe(ErrorType.QUERY_TIMEOUT);
    expect(classifyError(driverError('ConnectionError', 'ETIMEOUT'), ErrorType.QUERY_ERROR).errorType).toBe(ErrorType.CONNECTION_TIMEOUT);
  });

  it('classifies real mssql error classes', () => {
    const requestTimeout = new sql.RequestError('Timeout: Request failed to complete', 'ETIMEOUT');
    const connectTimeout = new sql.ConnectionError('Failed to connect in 15000ms', 'ETIMEOUT');
    expect(classifyError(requestTimeout, ErrorType.QUERY_ERROR).errorType).toBe(ErrorType.QUERY_TIMEOUT);
    expect(classifyError(connectTimeout, ErrorType.QUERY_ERROR).errorType).toBe(ErrorType.CONNECTION_TIMEOUT);
  });

  it('marks lost connections so the pool is rebuilt', () => {
    for (const code of ['ESOCKET', 'ECONNCLOSED', 'ECONNRESET']) {
      const result = classifyError(driverError('ConnectionError', code), ErrorType.QUERY_ERROR);
      expect(result.errorType).toBe(ErrorType.CONNECTION_ERROR);
      expect(result.connectionLost).toBe(true);
    }
  });

  it('treats a connection closed during a request as a lost connection', () => {
    const result = classifyError(driverError('RequestError', 'ECLOSE'), ErrorType.QUERY_ERROR);
    expect(result.errorType).toBe(ErrorType.CONNECTION_ERROR);
    expect(result.connectionLost).toBe(true);
  });

  it('does not rebuild the pool for login failures', () => {
    const result = classifyError(driverError('ConnectionError', 'ELOGIN'), ErrorType.QUERY_ERROR);
    expect(result.errorType).toBe(ErrorType.CONNECTION_ERROR);
    expect(result.connectionLost).toBe(false);
  });

  it('classifies cancellation', () => {
    expect(classifyError(driverError('RequestError', 'ECANCEL'), ErrorType.QUERY_ERROR).errorType).toBe(ErrorType.CANCELLED);
  });

  it('uses the SQL Server error number for permission and constraint errors', () => {
    expect(classifyError(driverError('RequestError', 'EREQUEST', 229), ErrorType.QUERY_ERROR).errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(classifyError(driverError('RequestError', 'EREQUEST', 547), ErrorType.QUERY_ERROR).errorType).toBe(ErrorType.VALIDATION_ERROR);
  });

  it('falls back to the default type for ordinary SQL errors, whatever the message says', () => {
    const err = driverError('RequestError', 'EREQUEST', 208);
    err.message = "Invalid object name 'connect_timeout_permission'.";
    const result = classifyError(err, ErrorType.QUERY_ERROR);
    expect(result.errorType).toBe(ErrorType.QUERY_ERROR);
    expect(result.connectionLost).toBe(false);
    expect(result.sqlErrorNumber).toBe(208);
  });

  it('keeps the type of an MssqlMcpError', () => {
    const err = new MssqlMcpError('nope', ErrorType.PERMISSION_ERROR);
    expect(classifyError(err, ErrorType.QUERY_ERROR).errorType).toBe(ErrorType.PERMISSION_ERROR);
  });
});

describe('extractDriverErrorInfo', () => {
  it('reads the number from a nested original error', () => {
    expect(extractDriverErrorInfo({ code: 'EREQUEST', originalError: { number: 3903 } })).toEqual({ code: 'EREQUEST', sqlErrorNumber: 3903 });
  });

  it('ignores non-numeric numbers', () => {
    expect(extractDriverErrorInfo({ code: 'ECANCEL', number: 'ECANCEL' })).toEqual({ code: 'ECANCEL' });
  });
});

describe('MssqlMcpError.fromError', () => {
  it('does not modify an MssqlMcpError it is given', () => {
    const original = new MssqlMcpError('boom', ErrorType.QUERY_ERROR, undefined, { a: 1 });
    const copy = MssqlMcpError.fromError(original, ErrorType.UNKNOWN_ERROR, { b: 2 });
    expect(original.details).toEqual({ a: 1 });
    expect(copy).not.toBe(original);
    expect(copy.details).toEqual({ a: 1, b: 2 });
    expect(copy.errorType).toBe(ErrorType.QUERY_ERROR);
    expect(copy.stack).toBe(original.stack);
  });

  it('returns the same MssqlMcpError when there is nothing to add', () => {
    const original = new MssqlMcpError('boom', ErrorType.QUERY_ERROR);
    expect(MssqlMcpError.fromError(original, ErrorType.UNKNOWN_ERROR)).toBe(original);
  });

  it('keeps the driver code and SQL error number', () => {
    const wrapped = MssqlMcpError.fromError(driverError('RequestError', 'EREQUEST', 208), ErrorType.QUERY_ERROR);
    expect(wrapped.code).toBe('EREQUEST');
    expect(wrapped.sqlErrorNumber).toBe(208);
  });
});

describe('toClientError', () => {
  it('sends only error, errorType, code and sqlErrorNumber', () => {
    const wrapped = toMssqlMcpError(driverError('RequestError', 'EREQUEST', 208), ErrorType.QUERY_ERROR, { query: 'SELECT secret' });
    const payload = toClientError(wrapped);
    expect(payload).toEqual({ error: wrapped.message, errorType: ErrorType.QUERY_ERROR, code: 'EREQUEST', sqlErrorNumber: 208 });
    expect(JSON.stringify(payload)).not.toContain('stack');
  });

  it('omits code and number when there are none', () => {
    expect(toClientError(new MssqlMcpError('x', ErrorType.VALIDATION_ERROR))).toEqual({ error: 'x', errorType: ErrorType.VALIDATION_ERROR });
  });

  it('does not leak originalValue for non-Error values', () => {
    const wrapped = MssqlMcpError.fromError({ secret: 'value' }, ErrorType.UNKNOWN_ERROR);
    expect(wrapped.details?.originalValue).toEqual({ secret: 'value' });
    expect(JSON.stringify(toClientError(wrapped))).not.toContain('secret');
  });
});
