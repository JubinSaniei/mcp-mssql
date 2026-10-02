import { createRequire } from 'node:module';
import { encodeDateTimeOffset } from '../datetimeoffsetPatch.js';

/** Helpers that build SQL Server date/time values as they appear in a TDS row and decode them with the real driver. */

export interface ReadResult {
  value: unknown;
  offset: number;
}
export type ReadValue = (buf: Buffer, offset: number, metadata: unknown, options: unknown) => ReadResult;

const requireHere = createRequire(import.meta.url);
const requireFromMssql = createRequire(requireHere.resolve('mssql'));

export const tedious = requireFromMssql('tedious') as { TYPES: Record<string, { name: string }> };
export const valueParser = createRequire(requireFromMssql.resolve('tedious'))('./value-parser.js') as { readValue: ReadValue };

/** The driver's own readValue, without any wrapper installed by the server. */
export function originalReadValue(): ReadValue {
  const current = valueParser.readValue as ReadValue & { [key: symbol]: unknown };
  return (current[Symbol.for('mcp-mssql.readValueOriginal')] as ReadValue | undefined) ?? current;
}

const timeLength = (scale: number) => (scale <= 2 ? 3 : scale <= 4 ? 4 : 5);

function daysSince(year: number, month: number, day: number, epochYear: number): number {
  const epoch = new Date(0);
  epoch.setUTCFullYear(epochYear, 0, 1);
  const target = new Date(0);
  target.setUTCFullYear(year, month - 1, day);
  return Math.round((target.getTime() - epoch.getTime()) / 86_400_000);
}

/** Time of day in units of 10^-scale seconds. `fraction` is the fractional-second digits as written in SQL. */
function timeUnits(hours: number, minutes: number, seconds: number, fraction: string, scale: number): bigint {
  const digits = fraction.padEnd(scale, '0').slice(0, scale);
  const whole = BigInt(hours * 3600 + minutes * 60 + seconds);
  return whole * 10n ** BigInt(scale) + (scale > 0 ? BigInt(digits) : 0n);
}

function writeTime(buf: Buffer, at: number, units: bigint, scale: number): number {
  let rest = units;
  for (let i = 0; i < timeLength(scale); i++) {
    buf.writeUInt8(Number(rest & 0xffn), at + i);
    rest >>= 8n;
  }
  return at + timeLength(scale);
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  fraction?: string;
}

export function encodeDate(parts: Parts | null): Buffer {
  if (parts === null) return Buffer.from([0]);
  const buf = Buffer.alloc(4);
  buf.writeUInt8(3, 0);
  buf.writeUIntLE(daysSince(parts.year, parts.month, parts.day, 1), 1, 3);
  return buf;
}

export function encodeTime(parts: Omit<Parts, 'year' | 'month' | 'day'> | null, scale: number): Buffer {
  if (parts === null) return Buffer.from([0]);
  const buf = Buffer.alloc(1 + timeLength(scale));
  buf.writeUInt8(timeLength(scale), 0);
  writeTime(buf, 1, timeUnits(parts.hours ?? 0, parts.minutes ?? 0, parts.seconds ?? 0, parts.fraction ?? '', scale), scale);
  return buf;
}

export function encodeDateTime2(parts: Parts | null, scale: number): Buffer {
  if (parts === null) return Buffer.from([0]);
  const buf = Buffer.alloc(1 + timeLength(scale) + 3);
  buf.writeUInt8(timeLength(scale) + 3, 0);
  const at = writeTime(buf, 1, timeUnits(parts.hours ?? 0, parts.minutes ?? 0, parts.seconds ?? 0, parts.fraction ?? '', scale), scale);
  buf.writeUIntLE(daysSince(parts.year, parts.month, parts.day, 1), at, 3);
  return buf;
}

/** A datetimeoffset value given as its local wall-clock time and offset, as written in SQL. */
export function encodeDateTimeOffsetLocal(parts: Parts | null, scale: number, offsetMinutes: number): Buffer {
  if (parts === null) return encodeDateTimeOffset(null, scale);
  const local = new Date(0);
  local.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  local.setUTCHours(parts.hours ?? 0, parts.minutes ?? 0, parts.seconds ?? 0, 0);
  const utc = new Date(local.getTime() - offsetMinutes * 60_000);
  const units = timeUnits(utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(), parts.fraction ?? '', scale);
  return encodeDateTimeOffset({ year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate(), timeUnits: units }, scale, offsetMinutes);
}

/** sql_variant base-type bytes. */
export const VARIANT_BASE_TYPE = { Int: 0x38, Date: 0x28, Time: 0x29, DateTime2: 0x2a, DateTimeOffset: 0x2b } as const;

/**
 * A sql_variant value: the 4-byte total length, the base-type byte, the property length,
 * the properties, then `payload` (the value without its own length byte). `null` is a NULL
 * variant, which is a total length of 0.
 */
export function encodeVariantRaw(baseType: number, props: number[], payload: Buffer | null): Buffer {
  if (payload === null) return Buffer.alloc(4);
  const header = Buffer.alloc(6);
  header.writeUInt32LE(2 + props.length + payload.length, 0);
  header.writeUInt8(baseType, 4);
  header.writeUInt8(props.length, 5);
  return Buffer.concat([header, Buffer.from(props), payload]);
}

/** A datetimeoffset inside a sql_variant, given as its local wall-clock time and offset. */
export function encodeVariantDateTimeOffsetLocal(parts: Parts | null, scale: number, offsetMinutes: number): Buffer {
  return encodeVariantRaw(VARIANT_BASE_TYPE.DateTimeOffset, [scale], parts === null ? null : encodeDateTimeOffsetLocal(parts, scale, offsetMinutes).subarray(1));
}

export function encodeVariantDateTime2(parts: Parts, scale: number): Buffer {
  return encodeVariantRaw(VARIANT_BASE_TYPE.DateTime2, [scale], encodeDateTime2(parts, scale).subarray(1));
}

export function encodeVariantDate(parts: Parts): Buffer {
  return encodeVariantRaw(VARIANT_BASE_TYPE.Date, [], encodeDate(parts).subarray(1));
}

export function encodeVariantTime(parts: Omit<Parts, 'year' | 'month' | 'day'>, scale: number): Buffer {
  return encodeVariantRaw(VARIANT_BASE_TYPE.Time, [scale], encodeTime(parts, scale).subarray(1));
}

export function encodeVariantInt(value: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeInt32LE(value, 0);
  return encodeVariantRaw(VARIANT_BASE_TYPE.Int, [], payload);
}

/** datetime: days since 1900-01-01 and 1/300-second ticks since midnight. */
export function encodeDateTime(parts: Parts, ticks: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeInt32LE(daysSince(parts.year, parts.month, parts.day, 1900), 0);
  buf.writeInt32LE(ticks, 4);
  return buf;
}

/** smalldatetime: days since 1900-01-01 and minutes since midnight. */
export function encodeSmallDateTime(parts: Parts): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt16LE(daysSince(parts.year, parts.month, parts.day, 1900), 0);
  buf.writeUInt16LE((parts.hours ?? 0) * 60 + (parts.minutes ?? 0), 2);
  return buf;
}

/** Decodes a value with `readValue` (the driver's own by default) using UTC dates, as the server does. */
export function decode(buf: Buffer, typeName: string, scale = 7, readValue: ReadValue = originalReadValue()): unknown {
  const result = readValue(buf, 0, { type: tedious.TYPES[typeName], scale }, { useUTC: true });
  if (result.offset !== buf.length) throw new Error(`decoded ${result.offset} of ${buf.length} bytes`);
  return result.value;
}
