import sql from 'mssql';
import { MssqlMcpError, ErrorType } from './errors.js';

/** A stored procedure name split into schema and procedure, with brackets removed. */
export interface ProcedureName {
  schema: string;
  name: string;
  /** `schema.proc` in the original case; this is what is executed. */
  canonical: string;
  /** Lower-cased `schema.proc`; this is what allow-list entries are compared on. */
  key: string;
}

export type ProcedureNameParseResult =
  | { ok: true; procedure: ProcedureName }
  | { ok: false; reason: 'empty' | 'unqualified' | 'invalid' };

const NAME_PART = /^[a-zA-Z0-9_]+$/;

function unbracket(part: string): string | null {
  const trimmed = part.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    return NAME_PART.test(inner) ? inner : null;
  }
  return NAME_PART.test(trimmed) ? trimmed : null;
}

/**
 * Parses `schema.proc`, optionally written as `[schema].[proc]`. Each part may contain only
 * letters, digits and underscores. A name without a schema is reported as `unqualified`,
 * because SQL Server would resolve it against the caller's default schema.
 */
export function parseProcedureName(raw: string): ProcedureNameParseResult {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: false, reason: 'empty' };

  const parts = text.split('.');
  if (parts.length === 1) {
    return unbracket(parts[0]) === null ? { ok: false, reason: 'invalid' } : { ok: false, reason: 'unqualified' };
  }
  if (parts.length !== 2) return { ok: false, reason: 'invalid' };

  const schema = unbracket(parts[0]);
  const name = unbracket(parts[1]);
  if (schema === null || name === null) return { ok: false, reason: 'invalid' };

  const canonical = `${schema}.${name}`;
  return { ok: true, procedure: { schema, name, canonical, key: canonical.toLowerCase() } };
}

/**
 * Builds the set of allowed procedure keys from configured entries. Entries that are not
 * valid schema-qualified names are skipped and reported through `onIgnored`.
 */
export function buildAllowedProcedureSet(
  entries: readonly string[],
  onIgnored: (entry: string, reason: 'empty' | 'unqualified' | 'invalid') => void = () => {}
): Set<string> {
  const allowed = new Set<string>();
  for (const entry of entries) {
    const parsed = parseProcedureName(entry);
    if (parsed.ok) {
      allowed.add(parsed.procedure.key);
    } else if (parsed.reason !== 'empty') {
      onIgnored(entry, parsed.reason);
    }
  }
  return allowed;
}

/** Parses a requested procedure name, throwing a validation error that says what is wrong. */
export function requireProcedureName(raw: string): ProcedureName {
  const parsed = parseProcedureName(raw);
  if (parsed.ok) return parsed.procedure;
  const messages = {
    empty: 'Procedure name cannot be empty.',
    unqualified: `Procedure name '${raw}' must be schema-qualified, for example dbo.${String(raw).trim().replace(/^\[|\]$/g, '')}.`,
    invalid: `Invalid procedure name '${raw}'. Use schema.procedure or [schema].[procedure]; names may contain only letters, digits and underscores.`,
  } as const;
  throw new MssqlMcpError(messages[parsed.reason], ErrorType.VALIDATION_ERROR, undefined, { procedure: raw, reason: parsed.reason });
}

/** SQL Server parameter types accepted for stored procedure parameters. */
export const SQL_PARAMETER_TYPES = [
  'bigint',
  'binary',
  'bit',
  'char',
  'date',
  'datetime',
  'datetime2',
  'datetimeoffset',
  'decimal',
  'float',
  'image',
  'int',
  'money',
  'nchar',
  'ntext',
  'numeric',
  'nvarchar',
  'real',
  'smalldatetime',
  'smallint',
  'smallmoney',
  'text',
  'time',
  'tinyint',
  'uniqueidentifier',
  'varbinary',
  'varchar',
  'variant',
  'xml',
] as const;

export type SqlParameterType = (typeof SQL_PARAMETER_TYPES)[number];

const LENGTH_TYPES: Readonly<Record<string, { max: number; allowsMax: boolean }>> = {
  binary: { max: 8000, allowsMax: false },
  char: { max: 8000, allowsMax: false },
  nchar: { max: 4000, allowsMax: false },
  varbinary: { max: 8000, allowsMax: true },
  varchar: { max: 8000, allowsMax: true },
  nvarchar: { max: 4000, allowsMax: true },
};
const PRECISION_SCALE_TYPES: ReadonlySet<string> = new Set(['decimal', 'numeric']);
const SCALE_ONLY_TYPES: ReadonlySet<string> = new Set(['time', 'datetime2', 'datetimeoffset']);

export interface ProcedureParameterInput {
  name: string;
  type: string;
  value?: unknown;
  direction?: 'in' | 'out';
  length?: number | 'max';
  precision?: number;
  scale?: number;
}

export type SqlTypeArgument = sql.ISqlType | (() => sql.ISqlType);

export interface PreparedProcedureParameter {
  /** Parameter name without the leading "@". */
  name: string;
  direction: 'in' | 'out';
  sqlType: SqlTypeArgument;
  value: unknown;
}

function invalidParameter(parameter: string, message: string): MssqlMcpError {
  return new MssqlMcpError(`Parameter '${parameter}': ${message}`, ErrorType.VALIDATION_ERROR, undefined, { parameter });
}

function isWholeNumberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Builds the driver type for a parameter from its type name and optional length,
 * precision and scale. Type names are case-insensitive. Unknown types, and options the
 * type does not take or values out of range, are validation errors.
 */
export function resolveSqlType(parameter: string, typeName: string, options: Pick<ProcedureParameterInput, 'length' | 'precision' | 'scale'> = {}): SqlTypeArgument {
  const type = typeof typeName === 'string' ? typeName.trim().toLowerCase() : '';
  if (!(SQL_PARAMETER_TYPES as readonly string[]).includes(type)) {
    throw invalidParameter(parameter, `unknown SQL type '${typeName}'. Supported types: ${SQL_PARAMETER_TYPES.join(', ')}.`);
  }
  const { length, precision, scale } = options;

  const lengthRule = LENGTH_TYPES[type];
  if (length !== undefined && !lengthRule) throw invalidParameter(parameter, `type '${type}' does not take a length.`);
  if ((precision !== undefined || scale !== undefined) && !PRECISION_SCALE_TYPES.has(type) && !SCALE_ONLY_TYPES.has(type)) {
    throw invalidParameter(parameter, `type '${type}' does not take a precision or scale.`);
  }
  if (precision !== undefined && SCALE_ONLY_TYPES.has(type)) throw invalidParameter(parameter, `type '${type}' takes a scale but no precision.`);

  switch (type) {
    case 'bigint': return sql.BigInt;
    case 'bit': return sql.Bit;
    case 'date': return sql.Date;
    case 'datetime': return sql.DateTime;
    case 'float': return sql.Float;
    case 'image': return sql.Image;
    case 'int': return sql.Int;
    case 'money': return sql.Money;
    case 'ntext': return sql.NText;
    case 'real': return sql.Real;
    case 'smalldatetime': return sql.SmallDateTime;
    case 'smallint': return sql.SmallInt;
    case 'smallmoney': return sql.SmallMoney;
    case 'text': return sql.Text;
    case 'tinyint': return sql.TinyInt;
    case 'uniqueidentifier': return sql.UniqueIdentifier;
    case 'variant': return sql.Variant;
    case 'xml': return sql.Xml;
  }

  if (lengthRule) {
    if (length === undefined) return LENGTH_FACTORIES[type]();
    if (length === 'max') {
      if (!lengthRule.allowsMax) throw invalidParameter(parameter, `type '${type}' does not support length 'max'.`);
      return LENGTH_FACTORIES[type](sql.MAX);
    }
    if (!isWholeNumberIn(length, 1, lengthRule.max)) throw invalidParameter(parameter, `length must be a whole number from 1 to ${lengthRule.max}${lengthRule.allowsMax ? ", or 'max'" : ''}.`);
    return LENGTH_FACTORIES[type](length);
  }

  if (PRECISION_SCALE_TYPES.has(type)) {
    const factory = type === 'decimal' ? sql.Decimal : sql.Numeric;
    if (precision === undefined && scale === undefined) return factory();
    const p = precision ?? 18;
    if (!isWholeNumberIn(p, 1, 38)) throw invalidParameter(parameter, 'precision must be a whole number from 1 to 38.');
    const s = scale ?? 0;
    if (!isWholeNumberIn(s, 0, p)) throw invalidParameter(parameter, `scale must be a whole number from 0 to the precision (${p}).`);
    return factory(p, s);
  }

  // time, datetime2, datetimeoffset. The scale defaults to 7: left unset, the driver would
  // declare a parameter whose value is null (such as an output parameter) with scale 0.
  const factory = type === 'time' ? sql.Time : type === 'datetime2' ? sql.DateTime2 : sql.DateTimeOffset;
  if (scale === undefined) return factory(7);
  if (!isWholeNumberIn(scale, 0, 7)) throw invalidParameter(parameter, 'scale must be a whole number from 0 to 7.');
  return factory(scale);
}

const LENGTH_FACTORIES: Readonly<Record<string, (length?: number) => sql.ISqlType>> = {
  // @types/mssql declares Binary without a length parameter; the driver accepts one
  binary: (length) => (length === undefined ? sql.Binary() : (sql.Binary as unknown as sql.ISqlTypeFactoryWithLength)(length)),
  char: (length) => (length === undefined ? sql.Char() : sql.Char(length)),
  nchar: (length) => (length === undefined ? sql.NChar() : sql.NChar(length)),
  varbinary: (length) => (length === undefined ? sql.VarBinary() : sql.VarBinary(length)),
  varchar: (length) => (length === undefined ? sql.VarChar() : sql.VarChar(length)),
  nvarchar: (length) => (length === undefined ? sql.NVarChar() : sql.NVarChar(length)),
};

/** Validates a parameter and resolves its driver type, before any SQL runs. */
export function prepareProcedureParameter(parameter: ProcedureParameterInput): PreparedProcedureParameter {
  const rawName = typeof parameter?.name === 'string' ? parameter.name.trim() : '';
  const name = rawName.startsWith('@') ? rawName.slice(1) : rawName;
  if (name === '') {
    throw new MssqlMcpError('Each parameter must have a name.', ErrorType.VALIDATION_ERROR, undefined, { parameter });
  }
  if (typeof parameter.type !== 'string' || parameter.type.trim() === '') {
    throw invalidParameter(name, 'a type is required.');
  }
  const direction = parameter.direction ?? 'in';
  if (direction !== 'in' && direction !== 'out') throw invalidParameter(name, "direction must be 'in' or 'out'.");

  return {
    name,
    direction,
    sqlType: resolveSqlType(name, parameter.type, parameter),
    value: parameter.value,
  };
}
