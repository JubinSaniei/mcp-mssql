import { describe, expect, it } from 'vitest';
import sql from 'mssql';
import {
  DATETIMEOFFSET_MINUTES,
  formatOutputParameters,
  formatTemporal,
  formatTemporalValue,
  formatUntypedDate,
  temporalColumnFromSqlType,
  temporalColumnFromType,
  type TemporalColumn,
} from '../temporalFormat.js';
import { wrapReadValue } from '../datetimeoffsetPatch.js';
import {
  decode,
  encodeDate,
  encodeDateTime,
  encodeDateTime2,
  encodeDateTimeOffsetLocal,
  encodeSmallDateTime,
  encodeTime,
  encodeVariantDate,
  encodeVariantDateTime2,
  encodeVariantDateTimeOffsetLocal,
  encodeVariantTime,
  originalReadValue,
} from './tdsTemporal.js';
import { toCompactJson } from '../resultFormat.js';

const col = (kind: TemporalColumn['kind'], scale = 7): TemporalColumn => ({ kind, scale });

/** Decodes with the driver and renders the value as the server does. */
function render(buf: Buffer, typeName: string, column: TemporalColumn, patched = true): unknown {
  const readValue = patched ? wrapReadValue(originalReadValue()) : originalReadValue();
  return formatTemporalValue(decode(buf, typeName, column.scale, readValue), column);
}

const OCT_1 = { year: 2026, month: 10, day: 1 };

describe('date', () => {
  it('renders as yyyy-mm-dd', () => {
    expect(render(encodeDate(OCT_1), 'Date', col('date'))).toBe('2026-10-01');
  });

  it('renders the first and last days of the range', () => {
    expect(render(encodeDate({ year: 1, month: 1, day: 1 }), 'Date', col('date'))).toBe('0001-01-01');
    expect(render(encodeDate({ year: 9999, month: 12, day: 31 }), 'Date', col('date'))).toBe('9999-12-31');
  });

  it('keeps NULL as null', () => {
    expect(render(encodeDate(null), 'Date', col('date'))).toBeNull();
  });
});

describe('time(n)', () => {
  it('renders time(7) with all seven fractional digits', () => {
    expect(render(encodeTime({ hours: 13, minutes: 45, fraction: '1234567' }, 7), 'Time', col('time', 7))).toBe('13:45:00.1234567');
  });

  it('renders time(0) without a fraction', () => {
    expect(render(encodeTime({ hours: 13, minutes: 45 }, 0), 'Time', col('time', 0))).toBe('13:45:00');
  });

  it('keeps trailing zeros up to the declared scale', () => {
    expect(render(encodeTime({ hours: 13, minutes: 45, fraction: '12' }, 3), 'Time', col('time', 3))).toBe('13:45:00.120');
    expect(render(encodeTime({ hours: 0 }, 7), 'Time', col('time', 7))).toBe('00:00:00.0000000');
  });

  it('renders the last tick of the day', () => {
    expect(render(encodeTime({ hours: 23, minutes: 59, seconds: 59, fraction: '9999999' }, 7), 'Time', col('time', 7))).toBe('23:59:59.9999999');
  });

  it('keeps NULL as null', () => {
    expect(render(encodeTime(null, 7), 'Time', col('time', 7))).toBeNull();
  });
});

describe('datetime2(n)', () => {
  const at = { ...OCT_1, hours: 12, minutes: 34, seconds: 56 };

  it('renders datetime2(7) with sub-millisecond digits, without Z or offset', () => {
    expect(render(encodeDateTime2({ ...at, fraction: '1234567' }, 7), 'DateTime2', col('datetime2', 7))).toBe('2026-10-01T12:34:56.1234567');
  });

  it('renders datetime2(0) without a fraction', () => {
    expect(render(encodeDateTime2(at, 0), 'DateTime2', col('datetime2', 0))).toBe('2026-10-01T12:34:56');
  });

  it('renders datetime2(3) with three digits', () => {
    expect(render(encodeDateTime2({ ...at, fraction: '5' }, 3), 'DateTime2', col('datetime2', 3))).toBe('2026-10-01T12:34:56.500');
  });

  it('renders the ends of the range', () => {
    expect(render(encodeDateTime2({ year: 1, month: 1, day: 1 }, 7), 'DateTime2', col('datetime2', 7))).toBe('0001-01-01T00:00:00.0000000');
    expect(render(encodeDateTime2({ year: 9999, month: 12, day: 31, hours: 23, minutes: 59, seconds: 59, fraction: '9999999' }, 7), 'DateTime2', col('datetime2', 7)))
      .toBe('9999-12-31T23:59:59.9999999');
  });

  it('keeps NULL as null', () => {
    expect(render(encodeDateTime2(null, 7), 'DateTime2', col('datetime2', 7))).toBeNull();
  });
});

describe('datetimeoffset(n)', () => {
  const at = { ...OCT_1, hours: 12, minutes: 34, seconds: 56 };

  it('keeps a positive non-whole-hour offset at scale 7', () => {
    expect(render(encodeDateTimeOffsetLocal({ ...at, fraction: '1234567' }, 7, 330), 'DateTimeOffset', col('datetimeoffset', 7)))
      .toBe('2026-10-01T12:34:56.1234567+05:30');
  });

  it('keeps a negative non-whole-hour offset at scale 0', () => {
    expect(render(encodeDateTimeOffsetLocal(at, 0, -210), 'DateTimeOffset', col('datetimeoffset', 0))).toBe('2026-10-01T12:34:56-03:30');
  });

  it('renders a zero offset as +00:00', () => {
    expect(render(encodeDateTimeOffsetLocal(at, 0, 0), 'DateTimeOffset', col('datetimeoffset', 0))).toBe('2026-10-01T12:34:56+00:00');
  });

  it('keeps the local date when the UTC instant falls on another day', () => {
    expect(render(encodeDateTimeOffsetLocal({ ...OCT_1, hours: 1 }, 3, 14 * 60), 'DateTimeOffset', col('datetimeoffset', 3))).toBe('2026-10-01T01:00:00.000+14:00');
    expect(render(encodeDateTimeOffsetLocal({ ...OCT_1, hours: 23, minutes: 30 }, 0, -12 * 60), 'DateTimeOffset', col('datetimeoffset', 0))).toBe('2026-10-01T23:30:00-12:00');
  });

  it('keeps NULL as null', () => {
    expect(render(encodeDateTimeOffsetLocal(null, 7, 0), 'DateTimeOffset', col('datetimeoffset', 7))).toBeNull();
  });

  it('renders the UTC instant with +00:00 when the driver is not patched', () => {
    expect(render(encodeDateTimeOffsetLocal({ ...at, fraction: '1234567' }, 7, 330), 'DateTimeOffset', col('datetimeoffset', 7), false))
      .toBe('2026-10-01T07:04:56.1234567+00:00');
    expect(render(encodeDateTimeOffsetLocal(at, 0, -210), 'DateTimeOffset', col('datetimeoffset', 0), false)).toBe('2026-10-01T16:04:56+00:00');
  });
});

describe('datetime and smalldatetime', () => {
  it('renders datetime with three fractional digits and no Z', () => {
    expect(render(encodeDateTime(OCT_1, 13_588_837), 'DateTime', col('datetime'))).toBe('2026-10-01T12:34:56.123');
    expect(render(encodeDateTime(OCT_1, 13_589_099), 'DateTime', col('datetime'))).toBe('2026-10-01T12:34:56.997');
    expect(render(encodeDateTime(OCT_1, 0), 'DateTime', col('datetime'))).toBe('2026-10-01T00:00:00.000');
    expect(render(encodeDateTime(OCT_1, 25_919_999), 'DateTime', col('datetime'))).toBe('2026-10-01T23:59:59.997');
  });

  it('renders smalldatetime to the minute with zero seconds', () => {
    expect(render(encodeSmallDateTime({ ...OCT_1, hours: 12, minutes: 34 }), 'SmallDateTime', col('smalldatetime'))).toBe('2026-10-01T12:34:00');
  });

  it('keeps null as null', () => {
    expect(formatTemporalValue(null, col('datetime'))).toBeNull();
    expect(formatTemporalValue(null, col('smalldatetime'))).toBeNull();
  });
});

describe('formatTemporal', () => {
  it('returns null for an invalid Date', () => {
    expect(formatTemporal(new Date(Number.NaN), col('datetime2'))).toBeNull();
  });

  it('does not depend on the process time zone', () => {
    const original = process.env.TZ;
    try {
      const outputs = ['UTC', 'Asia/Kolkata', 'America/St_Johns', 'Pacific/Kiritimati'].map((tz) => {
        process.env.TZ = tz;
        return [
          render(encodeDateTime2({ ...OCT_1, hours: 0, minutes: 30, fraction: '1' }, 7), 'DateTime2', col('datetime2', 7)),
          render(encodeDate(OCT_1), 'Date', col('date')),
          render(encodeTime({ hours: 2, minutes: 30 }, 0), 'Time', col('time', 0)),
          render(encodeDateTimeOffsetLocal({ ...OCT_1, hours: 2 }, 0, -210), 'DateTimeOffset', col('datetimeoffset', 0)),
        ];
      });
      for (const output of outputs) {
        expect(output).toEqual(['2026-10-01T00:30:00.1000000', '2026-10-01', '02:30:00', '2026-10-01T02:00:00-03:30']);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('ignores an out-of-range attached offset', () => {
    const value = new Date(Date.UTC(2026, 9, 1, 12));
    Object.defineProperty(value, DATETIMEOFFSET_MINUTES, { value: 5000 });
    expect(formatTemporal(value, col('datetimeoffset', 0))).toBe('2026-10-01T12:00:00+00:00');
  });
});

describe('formatUntypedDate', () => {
  it('renders date and time with trailing fractional zeros removed', () => {
    const value = new Date(Date.UTC(2026, 9, 1, 12, 34, 56, 120));
    Object.defineProperty(value, 'nanosecondsDelta', { value: 0.00045 });
    expect(formatUntypedDate(value)).toBe('2026-10-01T12:34:56.12045');
    expect(formatUntypedDate(new Date(Date.UTC(2026, 9, 1)))).toBe('2026-10-01T00:00:00');
  });

  it('includes an attached offset', () => {
    const value = new Date(Date.UTC(2026, 9, 1, 16, 4, 56, 500));
    Object.defineProperty(value, DATETIMEOFFSET_MINUTES, { value: -210 });
    expect(formatUntypedDate(value)).toBe('2026-10-01T12:34:56.5-03:30');
  });

  it('returns null for an invalid Date', () => {
    expect(formatUntypedDate(new Date('nope'))).toBeNull();
  });
});

describe('sql_variant date/time values', () => {
  const at = { ...OCT_1, hours: 7, minutes: 18, seconds: 20 };
  /** Decodes a sql_variant with the driver and serialises it as the tool output does. */
  const renderVariant = (buf: Buffer, patched = true) =>
    toCompactJson([decode(buf, 'Variant', 7, patched ? wrapReadValue(originalReadValue()) : originalReadValue())]);

  it.each([
    [330, 0, '', '["2026-10-01T07:18:20+05:30"]'],
    [330, 7, '1234567', '["2026-10-01T07:18:20.1234567+05:30"]'],
    [-210, 0, '', '["2026-10-01T07:18:20-03:30"]'],
    [-210, 7, '12', '["2026-10-01T07:18:20.12-03:30"]'],
    [0, 0, '', '["2026-10-01T07:18:20+00:00"]'],
    [0, 7, '0000001', '["2026-10-01T07:18:20.0000001+00:00"]'],
  ])('renders a datetimeoffset with offset %i at scale %i as local time plus the offset', (offset, scale, fraction, expected) => {
    expect(renderVariant(encodeVariantDateTimeOffsetLocal({ ...at, fraction }, scale, offset))).toBe(expected);
  });

  it('keeps the local date when the UTC instant falls on another day', () => {
    expect(renderVariant(encodeVariantDateTimeOffsetLocal({ ...OCT_1, hours: 1 }, 0, 14 * 60))).toBe('["2026-10-01T01:00:00+14:00"]');
  });

  it('renders a datetimeoffset as its UTC time with no offset when the driver is not patched', () => {
    expect(renderVariant(encodeVariantDateTimeOffsetLocal(at, 0, 330), false)).toBe('["2026-10-01T01:48:20"]');
    expect(renderVariant(encodeVariantDateTimeOffsetLocal({ ...at, fraction: '5' }, 7, -210), false)).toBe('["2026-10-01T10:48:20.5"]');
  });

  it('renders datetime2, date and time variants the same whether or not the driver is patched', () => {
    for (const patched of [true, false]) {
      expect(renderVariant(encodeVariantDateTime2({ ...at, fraction: '1234500' }, 7), patched)).toBe('["2026-10-01T07:18:20.12345"]');
      expect(renderVariant(encodeVariantDate(OCT_1), patched)).toBe('["2026-10-01T00:00:00"]');
      expect(renderVariant(encodeVariantTime({ hours: 13, minutes: 45 }, 0), patched)).toBe('["1970-01-01T13:45:00"]');
    }
  });

  it('keeps a NULL variant as null', () => {
    expect(renderVariant(encodeVariantDateTimeOffsetLocal(null, 7, 0))).toBe('[null]');
  });
});

describe('temporalColumnFromType / temporalColumnFromSqlType', () => {
  it('maps mssql types and scales', () => {
    expect(temporalColumnFromType(sql.Date)).toEqual({ kind: 'date', scale: 7 });
    expect(temporalColumnFromType(sql.Time, 0)).toEqual({ kind: 'time', scale: 0 });
    expect(temporalColumnFromType(sql.DateTime2, 3)).toEqual({ kind: 'datetime2', scale: 3 });
    expect(temporalColumnFromType(sql.DateTimeOffset, 7)).toEqual({ kind: 'datetimeoffset', scale: 7 });
    expect(temporalColumnFromType(sql.DateTime)).toEqual({ kind: 'datetime', scale: 7 });
    expect(temporalColumnFromType(sql.SmallDateTime)).toEqual({ kind: 'smalldatetime', scale: 7 });
  });

  it('treats a missing or invalid scale as 7', () => {
    expect(temporalColumnFromType(sql.Time, undefined)?.scale).toBe(7);
    expect(temporalColumnFromType(sql.Time, 9)?.scale).toBe(7);
  });

  it('returns null for other types', () => {
    expect(temporalColumnFromType(sql.Int)).toBeNull();
    expect(temporalColumnFromType(sql.Variant)).toBeNull();
    expect(temporalColumnFromType(undefined)).toBeNull();
  });

  it('reads parameter types given as factories or { type, scale }', () => {
    expect(temporalColumnFromSqlType(sql.DateTimeOffset(2))).toEqual({ kind: 'datetimeoffset', scale: 2 });
    expect(temporalColumnFromSqlType(sql.Date)).toEqual({ kind: 'date', scale: 7 });
    expect(temporalColumnFromSqlType(sql.NVarChar(10))).toBeNull();
    expect(temporalColumnFromSqlType('datetime2')).toBeNull();
  });
});

describe('formatOutputParameters', () => {
  it('renders date/time outputs by their declared type and leaves the rest alone', () => {
    const when = new Date(Date.UTC(2026, 9, 1, 12, 34, 56, 123));
    Object.defineProperty(when, 'nanosecondsDelta', { value: 0.0004567 });
    const output = { When: when, Day: new Date(Date.UTC(2026, 9, 1)), Total: 42, Missing: null };
    const formatted = formatOutputParameters(output, [
      { name: 'when', sqlType: sql.DateTime2(7) },
      { name: '@Day', sqlType: sql.Date },
      { name: 'Total', sqlType: sql.Int },
      { name: 'Missing', sqlType: sql.Time(0) },
    ]);
    expect(formatted).toEqual({ When: '2026-10-01T12:34:56.1234567', Day: '2026-10-01', Total: 42, Missing: null });
  });

  it('returns the output unchanged when no parameter has a date/time type', () => {
    const output = { Total: 42 };
    expect(formatOutputParameters(output, [{ name: 'Total', sqlType: sql.Int }])).toBe(output);
  });
});
