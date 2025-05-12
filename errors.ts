export enum ErrorType {
  UNKNOWN_ERROR = "UnknownError",
  CONNECTION_ERROR = "ConnectionError",
  CONNECTION_TIMEOUT = "ConnectionTimeout",
  QUERY_ERROR = "QueryError",
  STORED_PROCEDURE_ERROR = "StoredProcedureError",
  SCHEMA_ERROR = "SchemaError",
  VALIDATION_ERROR = "ValidationError",
  PERMISSION_ERROR = "PermissionError",
  DATABASE_ERROR = "DatabaseError",
  SQL_PARSER_ERROR = "SqlParserError"
}

// More specific type for details, can be expanded as needed
export type ErrorDetails = Record<string, any>; // Keeping it flexible for now, but can be a union of specific detail types

export class MssqlMcpError extends Error {
  public errorType: ErrorType;
  public originalError?: Error;
  public details?: ErrorDetails; // UPDATED TYPE

  constructor(message: string, errorType: ErrorType, originalError?: Error, details?: ErrorDetails) { // UPDATED TYPE
    super(message);
    this.name = this.constructor.name;
    this.errorType = errorType;
    this.originalError = originalError;
    this.details = details;
    Object.setPrototypeOf(this, MssqlMcpError.prototype);
  }

  static fromError(error: unknown, defaultErrorType: ErrorType, additionalDetails?: ErrorDetails): MssqlMcpError { // UPDATED TYPE
    if (error instanceof MssqlMcpError) {
      if (additionalDetails) {
        error.details = { ...(error.details || {}), ...additionalDetails };
      }
      return error;
    }

    let message = 'An unknown error occurred';
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
      message = error.message;
    }

    const newError = new MssqlMcpError(
      message,
      defaultErrorType,
      error instanceof Error ? error : undefined,
      {
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        ...(!(error instanceof Error) && typeof error === 'object' && error !== null ? { originalValue: error } : {}),
        ...(typeof error !== 'object' && !(error instanceof Error) ? { originalValue: error } : {}),
        ...additionalDetails,
      }
    );
    return newError;
  }
}
