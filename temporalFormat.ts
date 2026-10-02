/**
 * Renders SQL Server date and time values as their SQL text, at the column's declared
 * fractional-second scale.
 *
 * The driver delivers these values as JavaScript Dates built from UTC fields (the
 * connection runs with `useUTC: true`), so the UTC getters return the SQL wall-clock
 * fields and the result never depends on the Node process time zone. Digits below the
 * millisecond arrive as the Date's `nanosecondsDelta` (seconds, a multiple of 1e-7).
 * datetimeoffset Dates hold the UTC instant; their original offset is carried by the
 * `DATETIMEOFFSET_MINUTES` property when the driver patch in `datetimeoffsetPatch.ts`
 * is active, also for a datetimeoffset inside a sql_variant. Without it, datetimeoffset
 * columns are rendered as UTC with "+00:00", and a sql_variant datetimeoffset cannot be
 * told apart from a datetime2 and is rendered as its UTC time with no offset.
 */

export type TemporalKind = 'date' | 'time' | 'datetime2' | 'datetimeoffset' | 'datetime' | 'smalldatetime';

export interface TemporalColumn {
  kind: TemporalKind;
  /** Fractional-second digits, 0-7. Used by time, datetime2 and datetimeoffset. */
  scale: number;
}

/** Non-enumerable property holding a datetimeoffset value's UTC offset in minutes. */
export const DATETIMEOFFSET_MINUTES = Symbol.for('mcp-mssql.datetimeoffsetMinutes');

const TEMPORAL_KINDS: ReadonlySet<string> = new Set<TemporalKind>(['date', 'time', 'datetime2', 'datetimeoffset', 'datetime', 'smalldatetime']);
const MAX_SCALE = 7;
const TICKS_PER_MILLISECOND = 10_000;

function normaliseScale(scale: unknown): number {
  return typeof scale === 'number' && Number.isInteger(scale) && scale >= 0 && scale <= MAX_SCALE ? scale : MAX_SCALE;
}

/**
 * Identifies a date/time column from an mssql type (a type factory such as `sql.DateTime2`,
 * which carries a `declaration` name) and the column's scale. Returns null for other types.
 * A missing or invalid scale is treated as 7.
 */
export function temporalColumnFromType(type: unknown, scale?: unknown): TemporalColumn | null {
  if (typeof type !== 'function' && (type === null || typeof type !== 'object')) return null;
  const declaration = (type as { declaration?: unknown }).declaration;
  if (typeof declaration !== 'string' || !TEMPORAL_KINDS.has(declaration)) return null;
  return { kind: declaration as TemporalKind, scale: normaliseScale(scale) };
}

/**
 * Identifies a date/time parameter from the type passed to `request.input()`/`request.output()`:
 * either a type factory or an `{ type, scale }` object.
 */
export function temporalColumnFromSqlType(sqlType: unknown): TemporalColumn | null {
  if (typeof sqlType === 'function') return temporalColumnFromType(sqlType);
  if (sqlType !== null && typeof sqlType === 'object') {
    const { type, scale } = sqlType as { type?: unknown; scale?: unknown };
    return temporalColumnFromType(type, scale);
  }
  return null;
}

const pad = (value: number, width: number) => String(value).padStart(width, '0');

/** Sub-second part of the value as 100-nanosecond ticks, 0 to 9 999 999. */
function subSecondTicks(value: Date): number {
  const delta = (value as Date & { nanosecondsDelta?: unknown }).nanosecondsDelta;
  const extra = typeof delta === 'number' && Number.isFinite(delta) ? Math.round(delta * 1e7) : 0;
  const clamped = Math.min(Math.max(extra, 0), TICKS_PER_MILLISECOND - 1);
  return value.getUTCMilliseconds() * TICKS_PER_MILLISECOND + clamped;
}

/** ".fffffff" cut to `digits` digits, or "" for 0 digits. */
function fraction(value: Date, digits: number): string {
  if (digits <= 0) return '';
  return `.${pad(subSecondTicks(value), MAX_SCALE).slice(0, digits)}`;
}

/** ".fffffff" with trailing zeros removed, or "" when the value has no sub-second part. */
function trimmedFraction(value: Date): string {
  const digits = pad(subSecondTicks(value), MAX_SCALE).replace(/0+$/, '');
  return digits === '' ? '' : `.${digits}`;
}

function datePart(value: Date): string {
  return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1, 2)}-${pad(value.getUTCDate(), 2)}`;
}

function timePart(value: Date): string {
  return `${pad(value.getUTCHours(), 2)}:${pad(value.getUTCMinutes(), 2)}:${pad(value.getUTCSeconds(), 2)}`;
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const magnitude = Math.abs(minutes);
  return `${sign}${pad(Math.floor(magnitude / 60), 2)}:${pad(magnitude % 60, 2)}`;
}

/** The value's datetimeoffset offset in minutes, when one is attached and valid. */
export function attachedOffsetMinutes(value: Date): number | undefined {
  const minutes = (value as Date & { [DATETIMEOFFSET_MINUTES]?: unknown })[DATETIMEOFFSET_MINUTES];
  return typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= -14 * 60 && minutes <= 14 * 60 ? minutes : undefined;
}

/** The value shifted from its UTC instant to its local wall-clock time, plus the offset text. */
function localised(value: Date): { local: Date; offset: string } {
  const minutes = attachedOffsetMinutes(value) ?? 0;
  const local = new Date(value.getTime() + minutes * 60_000);
  const delta = (value as Date & { nanosecondsDelta?: unknown }).nanosecondsDelta;
  if (delta !== undefined) Object.defineProperty(local, 'nanosecondsDelta', { value: delta, enumerable: false });
  return { local, offset: offsetText(minutes) };
}

/**
 * Renders a date/time value of a known column type as SQL text:
 * date "2026-10-01", time(n) "13:45:00.1234567", datetime2(n) "2026-10-01T12:34:56.1234567",
 * datetimeoffset(n) "2026-10-01T12:34:56.1234567+05:30", datetime "2026-10-01T12:34:56.123",
 * smalldatetime "2026-10-01T12:34:00". Invalid Dates become null.
 */
export function formatTemporal(value: Date, column: TemporalColumn): string | null {
  if (Number.isNaN(value.getTime())) return null;
  switch (column.kind) {
    case 'date':
      return datePart(value);
    case 'time':
      return `${timePart(value)}${fraction(value, column.scale)}`;
    case 'datetime2':
      return `${datePart(value)}T${timePart(value)}${fraction(value, column.scale)}`;
    case 'datetime':
      return `${datePart(value)}T${timePart(value)}${fraction(value, 3)}`;
    case 'smalldatetime':
      return `${datePart(value)}T${timePart(value)}`;
    case 'datetimeoffset': {
      const { local, offset } = localised(value);
      return `${datePart(local)}T${timePart(local)}${fraction(local, column.scale)}${offset}`;
    }
  }
}

/**
 * Renders a Date whose column type is unknown (for example a sql_variant value) as
 * date-and-time text with trailing fractional zeros removed. A value that carries a
 * datetimeoffset offset is rendered as its local wall-clock time followed by the offset,
 * e.g. "2026-10-01T07:18:20+05:30". Invalid Dates become null.
 */
export function formatUntypedDate(value: Date): string | null {
  if (Number.isNaN(value.getTime())) return null;
  if (attachedOffsetMinutes(value) !== undefined) {
    const { local, offset } = localised(value);
    return `${datePart(local)}T${timePart(local)}${trimmedFraction(local)}${offset}`;
  }
  return `${datePart(value)}T${timePart(value)}${trimmedFraction(value)}`;
}

const parameterKey = (name: string) => name.replace(/^@/, '').toLowerCase();

/**
 * Renders date/time output parameter values as SQL text, using the type each parameter
 * was declared with. Other values, and values of parameters not in `parameters`, are
 * returned unchanged.
 */
export function formatOutputParameters(
  output: Record<string, unknown>,
  parameters: ReadonlyArray<{ name: string; sqlType: unknown }>
): Record<string, unknown> {
  const columns = new Map<string, TemporalColumn>();
  for (const parameter of parameters) {
    const column = temporalColumnFromSqlType(parameter.sqlType);
    if (column !== null) columns.set(parameterKey(parameter.name), column);
  }
  if (columns.size === 0) return output;
  const formatted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(output)) {
    formatted[name] = formatTemporalValue(value, columns.get(parameterKey(name)) ?? null);
  }
  return formatted;
}

/** Renders `value` as SQL text when it is a Date of a known date/time column; otherwise returns it unchanged. */
export function formatTemporalValue(value: unknown, column: TemporalColumn | null): unknown {
  return column !== null && value instanceof Date ? formatTemporal(value, column) : value;
}
