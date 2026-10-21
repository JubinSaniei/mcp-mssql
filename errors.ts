export enum ErrorType {
  UNKNOWN_ERROR = "UnknownError",
  CONNECTION_ERROR = "ConnectionError",
  CONNECTION_TIMEOUT = "ConnectionTimeout",
  QUERY_ERROR = "QueryError",
  QUERY_TIMEOUT = "QueryTimeout",
  CANCELLED = "Cancelled",
  STORED_PROCEDURE_ERROR = "StoredProcedureError",
  SCHEMA_ERROR = "SchemaError",
  VALIDATION_ERROR = "ValidationError",
  PERMISSION_ERROR = "PermissionError",
  DATABASE_ERROR = "DatabaseError",
  SQL_PARSER_ERROR = "SqlParserError"
}

// More specific type for details, can be expanded as needed
export type ErrorDetails = Record<string, unknown>;

export interface DriverErrorInfo {
  /** Driver error code such as ETIMEOUT, ESOCKET or EREQUEST. */
  code?: string;
  /** SQL Server error number, when the server reported one. */
  sqlErrorNumber?: number;
}

export class MssqlMcpError extends Error {
  public errorType: ErrorType;
  public originalError?: Error;
  public details?: ErrorDetails;
  public code?: string;
  public sqlErrorNumber?: number;

  constructor(message: string, errorType: ErrorType, originalError?: Error, details?: ErrorDetails, info?: DriverErrorInfo) {
    super(message);
    this.name = this.constructor.name;
    this.errorType = errorType;
    this.originalError = originalError;
    this.details = details;
    const extracted = info ?? (originalError ? extractDriverErrorInfo(originalError) : {});
    if (extracted.code !== undefined) this.code = extracted.code;
    if (extracted.sqlErrorNumber !== undefined) this.sqlErrorNumber = extracted.sqlErrorNumber;
    Object.setPrototypeOf(this, MssqlMcpError.prototype);
  }

  /**
   * Wraps any thrown value in an MssqlMcpError. An MssqlMcpError input is never modified:
   * it is returned as is, or copied when extra details have to be merged in.
   */
  static fromError(error: unknown, defaultErrorType: ErrorType, additionalDetails?: ErrorDetails): MssqlMcpError {
    if (error instanceof MssqlMcpError) {
      if (!additionalDetails) return error;
      const copy = new MssqlMcpError(
        error.message,
        error.errorType,
        error.originalError,
        { ...(error.details || {}), ...additionalDetails },
        { code: error.code, sqlErrorNumber: error.sqlErrorNumber }
      );
      if (error.stack) copy.stack = error.stack;
      return copy;
    }

    let message = 'An unknown error occurred';
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
      message = error.message;
    }

    return new MssqlMcpError(
      message,
      defaultErrorType,
      error instanceof Error ? error : undefined,
      {
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        ...(!(error instanceof Error) && error !== undefined && error !== null ? { originalValue: error } : {}),
        ...additionalDetails,
      },
      extractDriverErrorInfo(error)
    );
  }
}

/** The error payload sent to MCP clients. Stack traces and raw values stay in the logs. */
export interface ClientErrorPayload {
  error: string;
  errorType: ErrorType;
  code?: string;
  sqlErrorNumber?: number;
}

export function toClientError(error: MssqlMcpError): ClientErrorPayload {
  return {
    error: error.message,
    errorType: error.errorType,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.sqlErrorNumber !== undefined ? { sqlErrorNumber: error.sqlErrorNumber } : {}),
  };
}

/** Reads the driver error code and SQL Server error number from a driver error, if present. */
export function extractDriverErrorInfo(error: unknown): DriverErrorInfo {
  if (error === null || typeof error !== 'object') return {};
  const e = error as { code?: unknown; number?: unknown; originalError?: unknown; info?: { number?: unknown } };
  const nested = (e.originalError ?? null) as { code?: unknown; number?: unknown; info?: { number?: unknown } } | null;

  const code = typeof e.code === 'string' ? e.code : typeof nested?.code === 'string' ? nested.code : undefined;
  // msnodesqlv8 reports the SQL Server error number of a failed login as a numeric `code`. ODBC
  // errors raised outside SQL Server (driver not found, login timeout) carry 0, which is no error number.
  const numberCandidates = [e.number, e.info?.number, nested?.number, nested?.info?.number, e.code, nested?.code];
  const sqlErrorNumber = numberCandidates.find((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);

  return {
    ...(code !== undefined ? { code } : {}),
    ...(sqlErrorNumber !== undefined ? { sqlErrorNumber } : {}),
  };
}

/** The ODBC SQLSTATE of an msnodesqlv8 error (`state` once wrapped by mssql, `sqlstate` before), if present. */
export function extractSqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const e = error as { state?: unknown; sqlstate?: unknown; originalError?: { state?: unknown; sqlstate?: unknown } | null };
  const candidates = [e.state, e.sqlstate, e.originalError?.state, e.originalError?.sqlstate];
  return candidates.find((state): state is string => typeof state === 'string' && state.length === 5);
}

// ODBC SQLSTATE for a timeout, which msnodesqlv8 reports instead of ETIMEOUT
const SQLSTATE_TIMEOUT = 'HYT00';

/** Whether an ODBC SQLSTATE is in class 08, connection exceptions such as 08S01 (communication link failure). */
const isConnectionExceptionState = (state: string | undefined) => state !== undefined && state.startsWith('08');

/** Driver codes meaning the connection is unusable; the pool that produced them is rebuilt. */
const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set(['ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'ECLOSE', 'ENOTOPEN', 'ENOCONN']);

/** Driver codes for failures to reach or log in to SQL Server. */
const CONNECTION_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...CONNECTION_LOST_CODES,
  'ELOGIN',
  'EINSTLOOKUP',
  'EALREADYCONNECTED',
  'EALREADYCONNECTING',
  'ENOTFOUND',
  'ECONNREFUSED',
]);

/** SQL Server error numbers for permission and login failures. */
const PERMISSION_ERROR_NUMBERS: ReadonlySet<number> = new Set([229, 230, 262, 297, 300, 916, 4060, 15247, 18456]);

/** SQL Server error numbers for constraint violations. */
const CONSTRAINT_ERROR_NUMBERS: ReadonlySet<number> = new Set([547, 2601, 2627]);

export interface ErrorClassification extends DriverErrorInfo {
  errorType: ErrorType;
  /** True when the connection was lost and the pool it came from should be rebuilt. */
  connectionLost: boolean;
}

/**
 * Classifies an error by its driver code and SQL Server error number, never by message text.
 * `defaultErrorType` is used for SQL errors that have no more specific type.
 * An MssqlMcpError keeps the type it already has.
 */
export function classifyError(error: unknown, defaultErrorType: ErrorType): ErrorClassification {
  if (error instanceof MssqlMcpError) {
    return {
      errorType: error.errorType,
      connectionLost: error.code !== undefined && CONNECTION_LOST_CODES.has(error.code),
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.sqlErrorNumber !== undefined ? { sqlErrorNumber: error.sqlErrorNumber } : {}),
    };
  }

  const info = extractDriverErrorInfo(error);
  const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  const state = extractSqlState(error);
  const connectionLost = (info.code !== undefined && CONNECTION_LOST_CODES.has(info.code)) || isConnectionExceptionState(state);
  const result = (errorType: ErrorType): ErrorClassification => ({ errorType, connectionLost, ...info });

  if (state === SQLSTATE_TIMEOUT) {
    return result(name === 'ConnectionError' ? ErrorType.CONNECTION_TIMEOUT : ErrorType.QUERY_TIMEOUT);
  }

  switch (info.code) {
    case 'ETIMEOUT':
      return result(name === 'ConnectionError' ? ErrorType.CONNECTION_TIMEOUT : ErrorType.QUERY_TIMEOUT);
    case 'ECANCEL':
      return result(ErrorType.CANCELLED);
    case 'EARGS':
    case 'EINJECT':
    case 'EPARAM':
    case 'ENAME':
      return result(ErrorType.VALIDATION_ERROR);
  }

  if (connectionLost || (info.code !== undefined && CONNECTION_FAILURE_CODES.has(info.code))) {
    return result(ErrorType.CONNECTION_ERROR);
  }
  // Any other failure to connect, including a login msnodesqlv8 reports by its SQL Server error number
  if (name === 'ConnectionError') return result(ErrorType.CONNECTION_ERROR);
  if (info.sqlErrorNumber !== undefined) {
    if (PERMISSION_ERROR_NUMBERS.has(info.sqlErrorNumber)) return result(ErrorType.PERMISSION_ERROR);
    if (CONSTRAINT_ERROR_NUMBERS.has(info.sqlErrorNumber)) return result(ErrorType.VALIDATION_ERROR);
  }
  return result(defaultErrorType);
}

/** Converts any thrown value into an MssqlMcpError typed by `classifyError`. */
export function toMssqlMcpError(error: unknown, defaultErrorType: ErrorType, details?: ErrorDetails): MssqlMcpError {
  if (error instanceof MssqlMcpError) return MssqlMcpError.fromError(error, error.errorType, details);
  const { errorType } = classifyError(error, defaultErrorType);
  return MssqlMcpError.fromError(error, errorType, details);
}
