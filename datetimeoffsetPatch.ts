import { createRequire } from 'node:module';
import { DATETIMEOFFSET_MINUTES, formatTemporal, formatUntypedDate } from './temporalFormat.js';

/**
 * tedious reads a datetimeoffset value's UTC offset from the wire and discards it, keeping
 * only the UTC instant. This module wraps tedious's internal `readValue` (in
 * `tedious/lib/value-parser.js`, which every row, NBC row and return-value parser calls
 * through its module exports) so that each non-null datetimeoffset Date, whether from a
 * datetimeoffset column or inside a sql_variant, also carries its offset, in minutes, as
 * the non-enumerable `DATETIMEOFFSET_MINUTES` property.
 *
 * The wrapper never changes what the original returns or throws. Before it is installed,
 * a self-check feeds hand-built datetimeoffset and sql_variant values through it and
 * confirms the offsets come back; if anything about the driver is not as expected, nothing
 * is installed, datetimeoffset column values are rendered as UTC with "+00:00", and a
 * datetimeoffset inside a sql_variant is rendered as its UTC time with no offset.
 */

/** `offset-preserved` when the patch is installed, `utc-fallback` when it is not. */
export type DateTimeOffsetMode = 'offset-preserved' | 'utc-fallback';

interface ReadResult {
  value: unknown;
  offset: number;
}

type ReadValue = (buf: Buffer, offset: number, metadata: unknown, options: unknown) => ReadResult;

const WRAPPED_ORIGINAL = Symbol.for('mcp-mssql.readValueOriginal');

/** SQL Server stores offsets from -14:00 to +14:00. */
const MAX_OFFSET_MINUTES = 14 * 60;

/** Length in bytes of the time part of a datetimeoffset value with the given scale. */
function timeLength(scale: number): number {
  return scale <= 2 ? 3 : scale <= 4 ? 4 : 5;
}

/** sql_variant base-type byte of a datetimeoffset value (DateTimeOffsetN). */
const VARIANT_DATETIMEOFFSET = 0x2b;

/**
 * Bytes before the datetimeoffset payload in a sql_variant value: the 4-byte total length,
 * the base-type byte, the property-length byte and the scale byte.
 */
const VARIANT_DATETIMEOFFSET_HEADER = 7;

function metadataTypeName(metadata: unknown): unknown {
  const type = metadata !== null && typeof metadata === 'object' ? (metadata as { type?: unknown }).type : undefined;
  return type !== null && typeof type === 'object' ? (type as { name?: unknown }).name : undefined;
}

/**
 * Where the datetimeoffset payload starts in `buf` for a value read at `offset`, or
 * undefined when the value is not a datetimeoffset. A datetimeoffset column value starts
 * with its 1-byte length; a sql_variant value is a datetimeoffset only when its total
 * length is non-zero and its base-type byte is 0x2B.
 */
function dateTimeOffsetPayloadStart(buf: Buffer, offset: number, metadata: unknown): number | undefined {
  const typeName = metadataTypeName(metadata);
  if (typeName === 'DateTimeOffset') return offset + 1;
  if (typeName !== 'Variant') return undefined;
  if (!Number.isInteger(offset) || offset < 0 || offset + VARIANT_DATETIMEOFFSET_HEADER > buf.length) return undefined;
  if (buf.readUInt32LE(offset) === 0 || buf.readUInt8(offset + 4) !== VARIANT_DATETIMEOFFSET) return undefined;
  return offset + VARIANT_DATETIMEOFFSET_HEADER;
}

/**
 * Returns a `readValue` that calls `original` and returns its result unchanged. When the
 * value read is a non-null datetimeoffset, either as a datetimeoffset column or inside a
 * sql_variant, the signed 16-bit offset stored in the last two bytes of that value is
 * attached to the Date. Any failure in that extra step is ignored.
 */
export function wrapReadValue(original: ReadValue): ReadValue {
  const wrapped: ReadValue = (buf, offset, metadata, options) => {
    const result = original(buf, offset, metadata, options);
    try {
      const value = result?.value;
      const start = value instanceof Date && Buffer.isBuffer(buf) ? dateTimeOffsetPayloadStart(buf, offset, metadata) : undefined;
      if (value instanceof Date && start !== undefined) {
        const end = result.offset;
        if (Number.isInteger(end) && end - 2 >= start && end <= buf.length) {
          const minutes = buf.readInt16LE(end - 2);
          if (Math.abs(minutes) <= MAX_OFFSET_MINUTES) {
            Object.defineProperty(value, DATETIMEOFFSET_MINUTES, { value: minutes, enumerable: false, configurable: true });
          }
        }
      }
    } catch {
      // The value is still returned as read; it is rendered in UTC.
    }
    return result;
  };
  Object.defineProperty(wrapped, WRAPPED_ORIGINAL, { value: original, enumerable: false });
  return wrapped;
}

/** Days from 0001-01-01 to the given UTC date, as stored in the date part of the value. */
function daysSinceYearOne(year: number, monthIndex: number, day: number): number {
  const epoch = new Date(0);
  epoch.setUTCFullYear(1, 0, 1);
  return Math.round((Date.UTC(year, monthIndex, day) - epoch.getTime()) / 86_400_000);
}

/**
 * Encodes a datetimeoffset value as it appears in a row: a length byte, the UTC time of
 * day in units of 10^-scale seconds, the UTC date as days since 0001-01-01, and the
 * offset in minutes. Accepts `null` for a NULL value.
 */
export function encodeDateTimeOffset(
  utc: { year: number; month: number; day: number; timeUnits: bigint } | null,
  scale: number,
  offsetMinutes = 0
): Buffer {
  if (utc === null) return Buffer.from([0]);
  const timeBytes = timeLength(scale);
  const buf = Buffer.alloc(1 + timeBytes + 3 + 2);
  buf.writeUInt8(timeBytes + 5, 0);
  let units = utc.timeUnits;
  for (let i = 0; i < timeBytes; i++) {
    buf.writeUInt8(Number(units & 0xffn), 1 + i);
    units >>= 8n;
  }
  buf.writeUIntLE(daysSinceYearOne(utc.year, utc.month - 1, utc.day), 1 + timeBytes, 3);
  buf.writeInt16LE(offsetMinutes, 1 + timeBytes + 3);
  return buf;
}

/** sql_variant base-type byte of a datetime2 value (DateTime2N). */
const VARIANT_DATETIME2 = 0x2a;

/**
 * Encodes a sql_variant value holding a time-based type: the 4-byte total length, the
 * base-type byte, a property length of 1, the scale, then `payload` (the value without
 * its length byte). Accepts `null` for a NULL variant, which is a total length of 0.
 */
export function encodeVariant(baseType: number, scale: number, payload: Buffer | null): Buffer {
  if (payload === null) return Buffer.alloc(4);
  const buf = Buffer.alloc(VARIANT_DATETIMEOFFSET_HEADER + payload.length);
  buf.writeUInt32LE(3 + payload.length, 0);
  buf.writeUInt8(baseType, 4);
  buf.writeUInt8(1, 5);
  buf.writeUInt8(scale, 6);
  payload.copy(buf, VARIANT_DATETIMEOFFSET_HEADER);
  return buf;
}

/** A datetimeoffset value inside a sql_variant, with the same arguments as `encodeDateTimeOffset`. */
export function encodeVariantDateTimeOffset(
  utc: { year: number; month: number; day: number; timeUnits: bigint } | null,
  scale: number,
  offsetMinutes = 0
): Buffer {
  return encodeVariant(VARIANT_DATETIMEOFFSET, scale, utc === null ? null : encodeDateTimeOffset(utc, scale, offsetMinutes).subarray(1));
}

interface SelfCheckCase {
  column: 'datetimeoffset' | 'variant';
  buf: Buffer;
  scale: number;
  expected: string | null;
}

// 2026-10-01T12:34:56.1234567-03:30 is 16:04:56.1234567 UTC.
const SELF_CHECK_UTC_MINUS = { year: 2026, month: 10, day: 1, timeUnits: 578_961_234_567n };
// 2026-10-01T12:34:56+05:45 is 06:49:56 UTC.
const SELF_CHECK_UTC_PLUS = { year: 2026, month: 10, day: 1, timeUnits: 24_596n };

const SELF_CHECK_CASES: readonly SelfCheckCase[] = [
  { column: 'datetimeoffset', buf: encodeDateTimeOffset(SELF_CHECK_UTC_MINUS, 7, -210), scale: 7, expected: '2026-10-01T12:34:56.1234567-03:30' },
  { column: 'datetimeoffset', buf: encodeDateTimeOffset(SELF_CHECK_UTC_PLUS, 0, 345), scale: 0, expected: '2026-10-01T12:34:56+05:45' },
  { column: 'datetimeoffset', buf: encodeDateTimeOffset(null, 7), scale: 7, expected: null },
  { column: 'variant', buf: encodeVariantDateTimeOffset(SELF_CHECK_UTC_MINUS, 7, -210), scale: 7, expected: '2026-10-01T12:34:56.1234567-03:30' },
  { column: 'variant', buf: encodeVariantDateTimeOffset(SELF_CHECK_UTC_PLUS, 0, 345), scale: 0, expected: '2026-10-01T12:34:56+05:45' },
  {
    // A datetime2 payload is a datetimeoffset payload without the trailing 2-byte offset;
    // it must come back as the same wall-clock time with no offset attached.
    column: 'variant',
    buf: encodeVariant(VARIANT_DATETIME2, 0, encodeDateTimeOffset(SELF_CHECK_UTC_PLUS, 0, 345).subarray(1, -2)),
    scale: 0,
    expected: '2026-10-01T06:49:56',
  },
  { column: 'variant', buf: encodeVariantDateTimeOffset(null, 7), scale: 7, expected: null },
];

function isDriverType(type: unknown, name: string): boolean {
  return type !== null && typeof type === 'object' && (type as { name?: unknown }).name === name;
}

/**
 * Runs hand-built datetimeoffset and sql_variant values through `readValue` and checks that
 * each comes back with its offset (or, for a variant datetime2, without one) and renders as
 * the expected text. Returns a reason on failure, or null.
 */
export function selfCheckReadValue(readValue: ReadValue, dateTimeOffsetType: unknown, variantType: unknown): string | null {
  try {
    for (const { column, buf, scale, expected } of SELF_CHECK_CASES) {
      const type = column === 'variant' ? variantType : dateTimeOffsetType;
      const result = readValue(buf, 0, { type, scale }, { useUTC: true });
      if (result?.offset !== buf.length) return `unexpected read length for ${column} ${expected ?? 'NULL'}`;
      if (expected === null) {
        if (result.value !== null) return `NULL ${column} did not read as null`;
        continue;
      }
      if (!(result.value instanceof Date)) return `${column} ${expected} did not read as a Date`;
      const text = column === 'variant' ? formatUntypedDate(result.value) : formatTemporal(result.value, { kind: 'datetimeoffset', scale });
      if (text !== expected) return `${column} ${expected} rendered as ${text}`;
    }
    return null;
  } catch (err: unknown) {
    return `self-check threw: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export type PatchOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Installs the wrapper on a tedious value-parser module after the self-check passes.
 * Installing on a module that already has the wrapper is a no-op.
 */
export function patchValueParser(valueParser: unknown, dateTimeOffsetType: unknown, variantType: unknown): PatchOutcome {
  if (valueParser === null || typeof valueParser !== 'object') return { ok: false, reason: 'value-parser module not found' };
  const target = valueParser as { readValue?: unknown };
  const original = target.readValue;
  if (typeof original !== 'function') return { ok: false, reason: 'readValue is not a function' };
  if ((original as unknown as Record<symbol, unknown>)[WRAPPED_ORIGINAL] !== undefined) return { ok: true };
  if (!isDriverType(dateTimeOffsetType, 'DateTimeOffset')) return { ok: false, reason: 'DateTimeOffset type not found' };
  if (!isDriverType(variantType, 'Variant')) return { ok: false, reason: 'Variant type not found' };

  const wrapped = wrapReadValue(original as ReadValue);
  const failure = selfCheckReadValue(wrapped, dateTimeOffsetType, variantType);
  if (failure !== null) return { ok: false, reason: failure };

  try {
    target.readValue = wrapped;
  } catch (err: unknown) {
    return { ok: false, reason: `readValue could not be replaced: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (target.readValue !== wrapped) return { ok: false, reason: 'readValue could not be replaced' };
  return { ok: true };
}

export interface DriverModules {
  valueParser: unknown;
  dateTimeOffsetType: unknown;
  variantType: unknown;
}

/** Loads the value-parser module and the DateTimeOffset and Variant types of the tedious copy that mssql uses. */
function loadDriverModules(): DriverModules {
  const requireHere = createRequire(import.meta.url);
  const requireFromMssql = createRequire(requireHere.resolve('mssql'));
  const requireFromTedious = createRequire(requireFromMssql.resolve('tedious'));
  const tedious = requireFromMssql('tedious') as { TYPES?: { DateTimeOffset?: unknown; Variant?: unknown } };
  return {
    valueParser: requireFromTedious('./value-parser.js'),
    dateTimeOffsetType: tedious.TYPES?.DateTimeOffset,
    variantType: tedious.TYPES?.Variant,
  };
}

/** Loads the driver modules with `loadModules` and patches them, reporting why when it cannot. */
export function attemptDateTimeOffsetPatch(loadModules: () => DriverModules = loadDriverModules): PatchOutcome {
  try {
    const { valueParser, dateTimeOffsetType, variantType } = loadModules();
    return patchValueParser(valueParser, dateTimeOffsetType, variantType);
  } catch (err: unknown) {
    return { ok: false, reason: `driver modules could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface PatchInstallation {
  mode: DateTimeOffsetMode;
  /** Why the patch is not installed, in `utc-fallback` mode. */
  reason?: string;
  /** True only for the call that made the attempt. */
  firstAttempt: boolean;
}

let installed: Omit<PatchInstallation, 'firstAttempt'> | undefined;

/**
 * Installs the datetimeoffset patch on the first call and returns the active mode. Later
 * calls return the same mode without retrying.
 */
export function installDateTimeOffsetPatch(): PatchInstallation {
  if (installed !== undefined) return { ...installed, firstAttempt: false };
  const outcome = attemptDateTimeOffsetPatch();
  installed = outcome.ok ? { mode: 'offset-preserved' } : { mode: 'utc-fallback', reason: outcome.reason };
  return { ...installed, firstAttempt: true };
}
