import { describe, expect, it, vi } from 'vitest';
import {
  attemptDateTimeOffsetPatch,
  encodeDateTimeOffset,
  encodeVariantDateTimeOffset,
  installDateTimeOffsetPatch,
  patchValueParser,
  selfCheckReadValue,
  wrapReadValue,
} from '../datetimeoffsetPatch.js';
import { toCompactJson } from '../resultFormat.js';
import { DATETIMEOFFSET_MINUTES, formatTemporal } from '../temporalFormat.js';
import {
  decode,
  encodeDateTime2,
  encodeDateTimeOffsetLocal,
  encodeVariantDateTime2,
  encodeVariantDateTimeOffsetLocal,
  encodeVariantInt,
  encodeVariantRaw,
  originalReadValue,
  tedious,
  valueParser,
  VARIANT_BASE_TYPE,
  type ReadResult,
  type ReadValue,
} from './tdsTemporal.js';

const DTO = tedious.TYPES.DateTimeOffset;
const VARIANT = tedious.TYPES.Variant;
const at = { year: 2026, month: 10, day: 1, hours: 12, minutes: 34, seconds: 56 };
const offsetOf = (value: unknown) => (value as Record<symbol, unknown>)[DATETIMEOFFSET_MINUTES];

describe('wrapReadValue', () => {
  const original = originalReadValue();
  const wrapped = wrapReadValue(original);

  it.each([
    [330, 7, '1234567'],
    [-210, 7, '1234567'],
    [-210, 0, ''],
    [345, 0, ''],
    [0, 7, '0000001'],
    [-14 * 60, 3, '999'],
    [14 * 60, 0, ''],
  ])('attaches offset %i (scale %i) without changing what the driver returns', (offset, scale, fraction) => {
    const buf = encodeDateTimeOffsetLocal({ ...at, fraction }, scale, offset);
    const meta = { type: DTO, scale };
    const plain = original(buf, 0, meta, { useUTC: true });
    const patched = wrapped(buf, 0, meta, { useUTC: true });

    expect(patched.offset).toBe(plain.offset);
    const value = patched.value as Date & { nanosecondsDelta?: number };
    expect(value.getTime()).toBe((plain.value as Date).getTime());
    expect(value.nanosecondsDelta).toBe((plain.value as Date & { nanosecondsDelta?: number }).nanosecondsDelta);
    expect(offsetOf(value)).toBe(offset);
    expect(Object.keys(value)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(value, DATETIMEOFFSET_MINUTES)?.enumerable).toBe(false);
  });

  it('reads a value that starts part way into the buffer', () => {
    const value = encodeDateTimeOffsetLocal(at, 7, -210);
    const buf = Buffer.concat([Buffer.from([0xaa, 0xbb, 0xcc]), value, Buffer.from([0xdd])]);
    const result = wrapped(buf, 3, { type: DTO, scale: 7 }, { useUTC: true });
    expect(result.offset).toBe(3 + value.length);
    expect(offsetOf(result.value)).toBe(-210);
    expect(formatTemporal(result.value as Date, { kind: 'datetimeoffset', scale: 7 })).toBe('2026-10-01T12:34:56.0000000-03:30');
  });

  it('returns NULL as read', () => {
    const buf = encodeDateTimeOffsetLocal(null, 7, 0);
    expect(wrapped(buf, 0, { type: DTO, scale: 7 }, { useUTC: true })).toEqual(original(buf, 0, { type: DTO, scale: 7 }, { useUTC: true }));
    expect(decode(buf, 'DateTimeOffset', 7, wrapped)).toBeNull();
  });

  it('leaves other date/time types alone', () => {
    const value = decode(encodeDateTime2({ ...at, fraction: '1' }, 7), 'DateTime2', 7, wrapped);
    expect(value).toBeInstanceOf(Date);
    expect(offsetOf(value)).toBeUndefined();
  });

  it('passes errors from the driver through unchanged', () => {
    const failure = new Error('not enough data');
    const throwing = wrapReadValue(() => { throw failure; });
    expect(() => throwing(Buffer.alloc(0), 0, { type: DTO, scale: 7 }, {})).toThrow(failure);
  });

  it('never throws from its own step and leaves the value in UTC', () => {
    const frozen = Object.freeze(new Date(Date.UTC(2026, 9, 1, 16, 4, 56)));
    const buf = encodeDateTimeOffsetLocal(at, 0, -210);
    const result = wrapReadValue(() => ({ value: frozen, offset: buf.length }))(buf, 0, { type: DTO, scale: 0 }, {});
    expect(result.value).toBe(frozen);
    expect(offsetOf(frozen)).toBeUndefined();
    expect(formatTemporal(frozen, { kind: 'datetimeoffset', scale: 0 })).toBe('2026-10-01T16:04:56+00:00');

    const outOfBounds = wrapReadValue(() => ({ value: new Date(0), offset: 999 }));
    expect(offsetOf(outOfBounds(buf, 0, { type: DTO, scale: 0 }, {}).value)).toBeUndefined();
    const notBuffer = wrapReadValue(() => ({ value: new Date(0), offset: 2 }));
    expect(() => notBuffer('x' as unknown as Buffer, 0, { type: DTO, scale: 0 }, {})).not.toThrow();
  });
});

describe('wrapReadValue with sql_variant values', () => {
  const original = originalReadValue();
  const wrapped = wrapReadValue(original);
  const variantAt = { year: 2026, month: 10, day: 1, hours: 7, minutes: 18, seconds: 20 };
  const read = (buf: Buffer, readValue: ReadValue = wrapped, offset = 0) => readValue(buf, offset, { type: VARIANT }, { useUTC: true });

  it('reads a hand-built variant datetimeoffset as local time plus its offset', () => {
    // 65 000 000 000 ticks of 100 ns is 01:48:20 UTC, which is 07:18:20 at +05:30.
    const dto = encodeDateTimeOffset({ year: 2026, month: 10, day: 1, timeUnits: 65_000_000_000n }, 7, 330).subarray(1);
    const v = Buffer.alloc(7 + dto.length);
    v.writeUInt32LE(3 + dto.length, 0);
    v.writeUInt8(0x2b, 4);
    v.writeUInt8(1, 5);
    v.writeUInt8(7, 6);
    dto.copy(v, 7);
    expect(v).toEqual(encodeVariantDateTimeOffset({ year: 2026, month: 10, day: 1, timeUnits: 65_000_000_000n }, 7, 330));
    const { value, offset } = read(v);
    expect(offset).toBe(v.length);
    expect(toCompactJson([value])).toBe('["2026-10-01T07:18:20+05:30"]');
  });

  it.each([
    [330, 0, ''],
    [330, 7, '1234567'],
    [-210, 0, ''],
    [-210, 7, '1234567'],
    [0, 0, ''],
    [0, 7, '0000001'],
  ])('attaches offset %i (scale %i) without changing what the driver returns', (offsetMinutes, scale, fraction) => {
    const buf = encodeVariantDateTimeOffsetLocal({ ...variantAt, fraction }, scale, offsetMinutes);
    const plain = read(buf, original);
    const patched = read(buf);

    expect(patched.offset).toBe(plain.offset);
    expect(patched.offset).toBe(buf.length);
    const value = patched.value as Date & { nanosecondsDelta?: number };
    expect(value.getTime()).toBe((plain.value as Date).getTime());
    expect(value.nanosecondsDelta).toBe((plain.value as Date & { nanosecondsDelta?: number }).nanosecondsDelta);
    expect(offsetOf(value)).toBe(offsetMinutes);
    expect(Object.keys(value)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(value, DATETIMEOFFSET_MINUTES)?.enumerable).toBe(false);
  });

  it('reads a variant that starts part way into the buffer', () => {
    const value = encodeVariantDateTimeOffsetLocal(variantAt, 0, -210);
    const buf = Buffer.concat([Buffer.from([0x2b, 0x2b]), value, Buffer.from([0xff])]);
    const result = read(buf, wrapped, 2);
    expect(result.offset).toBe(2 + value.length);
    expect(offsetOf(result.value)).toBe(-210);
  });

  it('leaves variants of other types untouched', () => {
    for (const buf of [encodeVariantInt(42), encodeVariantDateTime2({ ...variantAt, fraction: '1' }, 7)]) {
      const plain = read(buf, original);
      const patched = read(buf);
      expect(patched).toEqual(plain);
      expect(offsetOf(patched.value)).toBeUndefined();
    }
    expect(read(encodeVariantInt(42)).value).toBe(42);
  });

  it('returns NULL and zero-length variants as read', () => {
    const nullVariant = encodeVariantDateTimeOffsetLocal(null, 7, 0);
    expect(nullVariant).toEqual(Buffer.alloc(4));
    expect(read(nullVariant)).toEqual(read(nullVariant, original));
    expect(read(nullVariant).value).toBeNull();
    expect(read(encodeVariantRaw(VARIANT_BASE_TYPE.DateTimeOffset, [7], null)).value).toBeNull();
  });

  it('does not throw from its own step on a truncated buffer', () => {
    const full = encodeVariantDateTimeOffsetLocal(variantAt, 7, 330);
    for (let length = 0; length < full.length; length++) {
      const truncated = full.subarray(0, length);
      let driverError: unknown;
      try {
        read(truncated, original);
      } catch (err: unknown) {
        driverError = err;
      }
      if (driverError === undefined) expect(() => read(truncated)).not.toThrow();
      else expect(() => read(truncated)).toThrow(driverError as Error);
    }

    // A reader that reports success on a header-only buffer gets no offset and no exception.
    const header = full.subarray(0, 5);
    const lying = wrapReadValue(() => ({ value: new Date(0), offset: header.length }));
    expect(() => read(header, lying)).not.toThrow();
    expect(offsetOf(read(header, lying).value)).toBeUndefined();
    const beyond = wrapReadValue(() => ({ value: new Date(0), offset: full.length + 10 }));
    expect(offsetOf(read(full, beyond).value)).toBeUndefined();
    expect(offsetOf(wrapReadValue(() => ({ value: new Date(0), offset: 9 }))(full, -3, { type: VARIANT }, {}).value)).toBeUndefined();
  });
});

describe('selfCheckReadValue', () => {
  it('passes for the wrapped driver reader', () => {
    expect(selfCheckReadValue(wrapReadValue(originalReadValue()), DTO, VARIANT)).toBeNull();
  });

  it('fails for the unwrapped driver reader, which drops the offset', () => {
    expect(selfCheckReadValue(originalReadValue(), DTO, VARIANT)).toMatch(/rendered as 2026-10-01T16:04:56\.1234567\+00:00/);
  });

  it('fails when only variant datetimeoffset values lose their offset', () => {
    const wrapped = wrapReadValue(originalReadValue());
    const columnsOnly: ReadValue = (buf, offset, metadata, options) =>
      (metadata as { type?: { name?: string } }).type?.name === 'Variant' ? originalReadValue()(buf, offset, metadata, options) : wrapped(buf, offset, metadata, options);
    expect(selfCheckReadValue(columnsOnly, DTO, VARIANT)).toBe('variant 2026-10-01T12:34:56.1234567-03:30 rendered as 2026-10-01T16:04:56.1234567');
  });

  it('fails when the reader throws or returns something unexpected', () => {
    expect(selfCheckReadValue(() => { throw new Error('boom'); }, DTO, VARIANT)).toMatch(/self-check threw: boom/);
    expect(selfCheckReadValue((buf) => ({ value: 'text', offset: buf.length }), DTO, VARIANT)).toMatch(/did not read as a Date/);
    expect(selfCheckReadValue(() => ({ value: null, offset: 1 }), DTO, VARIANT)).toMatch(/unexpected read length/);
  });
});

describe('patchValueParser', () => {
  it('installs the wrapper once and is idempotent', () => {
    const module = { readValue: originalReadValue() };
    expect(patchValueParser(module, DTO, VARIANT)).toEqual({ ok: true });
    const installed = module.readValue;
    expect(installed).not.toBe(originalReadValue());
    expect(patchValueParser(module, DTO, VARIANT)).toEqual({ ok: true });
    expect(module.readValue).toBe(installed);
    expect(offsetOf(decode(encodeDateTimeOffsetLocal(at, 0, -210), 'DateTimeOffset', 0, module.readValue))).toBe(-210);
    expect(offsetOf(decode(encodeVariantDateTimeOffsetLocal(at, 0, -210), 'Variant', 0, module.readValue))).toBe(-210);
  });

  it('does not install when the self-check fails', () => {
    const broken: ReadValue = (): ReadResult => ({ value: new Date(0), offset: 0 });
    const module = { readValue: broken };
    const outcome = patchValueParser(module, DTO, VARIANT);
    expect(outcome.ok).toBe(false);
    expect(module.readValue).toBe(broken);
  });

  it('does not install when the module or type is not as expected', () => {
    expect(patchValueParser(null, DTO, VARIANT)).toEqual({ ok: false, reason: 'value-parser module not found' });
    expect(patchValueParser({}, DTO, VARIANT)).toEqual({ ok: false, reason: 'readValue is not a function' });
    expect(patchValueParser({ readValue: originalReadValue() }, undefined, VARIANT)).toEqual({ ok: false, reason: 'DateTimeOffset type not found' });
    expect(patchValueParser({ readValue: originalReadValue() }, tedious.TYPES.DateTime2, VARIANT)).toEqual({ ok: false, reason: 'DateTimeOffset type not found' });
    expect(patchValueParser({ readValue: originalReadValue() }, DTO, undefined)).toEqual({ ok: false, reason: 'Variant type not found' });
  });

  it('reports a module whose readValue cannot be replaced', () => {
    const module = Object.freeze({ readValue: originalReadValue() });
    expect(patchValueParser(module, DTO, VARIANT).ok).toBe(false);
  });
});

describe('attemptDateTimeOffsetPatch / installDateTimeOffsetPatch', () => {
  it('falls back when the driver modules cannot be loaded', () => {
    const outcome = attemptDateTimeOffsetPatch(() => { throw new Error('Cannot find module'); });
    expect(outcome).toEqual({ ok: false, reason: 'driver modules could not be loaded: Cannot find module' });
  });

  it('falls back when the loaded reader fails the self-check', () => {
    const readValue = vi.fn((): ReadResult => ({ value: null, offset: 0 }));
    const valueParserModule = { readValue };
    expect(attemptDateTimeOffsetPatch(() => ({ valueParser: valueParserModule, dateTimeOffsetType: DTO, variantType: VARIANT })).ok).toBe(false);
    expect(valueParserModule.readValue).toBe(readValue);
  });

  it('patches the tedious copy that mssql uses, once per process', () => {
    const first = installDateTimeOffsetPatch();
    const second = installDateTimeOffsetPatch();
    expect(first.mode).toBe('offset-preserved');
    expect(second).toEqual({ mode: 'offset-preserved', firstAttempt: false });
    const value = decode(encodeDateTimeOffsetLocal({ ...at, fraction: '1234567' }, 7, -210), 'DateTimeOffset', 7, valueParser.readValue);
    expect(formatTemporal(value as Date, { kind: 'datetimeoffset', scale: 7 })).toBe('2026-10-01T12:34:56.1234567-03:30');
    const variant = decode(encodeVariantDateTimeOffsetLocal({ ...at, fraction: '1234567' }, 7, 330), 'Variant', 7, valueParser.readValue);
    expect(toCompactJson([variant])).toBe('["2026-10-01T12:34:56.1234567+05:30"]');
  });
});
