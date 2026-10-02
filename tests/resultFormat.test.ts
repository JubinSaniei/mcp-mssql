import { describe, expect, it } from 'vitest';
import sql from 'mssql';
import {
  MAX_BINARY_OUTPUT_BYTES,
  RecordsetPager,
  buildQueryResult,
  columnNamesFromMetadata,
  resolvePageWindow,
  rowToArray,
  toCompactJson,
  toJsonSafe,
} from '../resultFormat.js';

const cols = (...names: string[]) => names.map((name, index) => ({ name, index }));

function feed(pager: RecordsetPager, columns: unknown, rows: unknown[]): boolean[] {
  pager.startRecordset(columns);
  return rows.map((row) => pager.addRow(row));
}

describe('resolvePageWindow', () => {
  it('defaults limit to maxRows and offset to 0', () => {
    expect(resolvePageWindow(undefined, undefined, 1000)).toEqual({ offset: 0, limit: 1000 });
  });

  it('never lets limit exceed maxRows', () => {
    expect(resolvePageWindow(10, 5000, 1000)).toEqual({ offset: 10, limit: 1000 });
  });

  it('keeps a smaller limit', () => {
    expect(resolvePageWindow(0, 25, 1000)).toEqual({ offset: 0, limit: 25 });
  });

  it('ignores invalid values', () => {
    expect(resolvePageWindow(-3, 0, 50)).toEqual({ offset: 0, limit: 50 });
    expect(resolvePageWindow(Number.NaN, Number.NaN, Number.NaN)).toEqual({ offset: 0, limit: 1 });
  });
});

describe('columnNamesFromMetadata', () => {
  it('keeps duplicate and unnamed columns in column order', () => {
    const metadata = [
      { name: 'id', index: 0 },
      { name: 'id', index: 1 },
      { name: '', index: 2 },
      { name: '', index: 3 },
    ];
    expect(columnNamesFromMetadata(metadata)).toEqual(['id', 'id', '', '']);
  });

  it('sorts object-keyed metadata by index', () => {
    expect(columnNamesFromMetadata({ b: { name: 'b', index: 1 }, a: { name: 'a', index: 0 } })).toEqual(['a', 'b']);
  });

  it('returns [] for missing metadata', () => {
    expect(columnNamesFromMetadata(undefined)).toEqual([]);
  });
});

describe('rowToArray', () => {
  it('passes arrays through and flattens objects', () => {
    expect(rowToArray([1, 2])).toEqual([1, 2]);
    expect(rowToArray({ 0: 'json text' })).toEqual(['json text']);
  });
});

describe('RecordsetPager', () => {
  it('keeps only the rows inside the window and signals the first row past it', () => {
    const pager = new RecordsetPager({ offset: 2, limit: 2 });
    const signals = feed(pager, cols('n'), [[0], [1], [2], [3], [4], [5]]);
    expect(signals).toEqual([false, false, false, false, true, false]);
    const [rs] = pager.recordsets();
    expect(rs.rows).toEqual([[2], [3]]);
    expect(rs.recordCount).toBe(2);
    expect(rs.hasMore).toBe(true);
    expect(rs.nextOffset).toBe(4);
  });

  it('reports hasMore false when the result set ends inside the window', () => {
    const pager = new RecordsetPager({ offset: 0, limit: 5 });
    feed(pager, cols('n'), [[0], [1], [2]]);
    const [rs] = pager.recordsets();
    expect(rs.hasMore).toBe(false);
    expect(rs).not.toHaveProperty('nextOffset');
  });

  it('reports hasMore false when the result set has exactly limit rows', () => {
    const pager = new RecordsetPager({ offset: 0, limit: 3 });
    feed(pager, cols('n'), [[0], [1], [2]]);
    expect(pager.recordsets()[0].hasMore).toBe(false);
  });

  it('pages each of several result sets independently', () => {
    const pager = new RecordsetPager({ offset: 0, limit: 2 });
    feed(pager, cols('a'), [[1], [2], [3]]);
    feed(pager, cols('b', 'b', ''), [[1, 2, 3]]);
    feed(pager, cols('c'), []);
    const sets = pager.recordsets();
    expect(sets.map((s) => s.columns)).toEqual([['a'], ['b', 'b', ''], ['c']]);
    expect(sets.map((s) => s.hasMore)).toEqual([true, false, false]);
    expect(sets.map((s) => s.recordCount)).toEqual([2, 1, 0]);
    expect(pager.returnedRowCount).toBe(3);
    expect(pager.anyHasMore).toBe(true);
  });

  it('caps unpaged result sets at the limit without nextOffset', () => {
    const pager = new RecordsetPager({ offset: 0, limit: 2 }, false);
    feed(pager, cols('n'), [[1], [2], [3], [4]]);
    const [rs] = pager.recordsets();
    expect(rs.rows).toEqual([[1], [2]]);
    expect(rs.hasMore).toBe(true);
    expect(rs).not.toHaveProperty('nextOffset');
  });

  it('renders date/time columns as SQL text at their declared scale', () => {
    const at = (ms: number, nanosecondsDelta = 0) => {
      const value = new Date(Date.UTC(2026, 9, 1, 12, 34, 56, ms));
      Object.defineProperty(value, 'nanosecondsDelta', { value: nanosecondsDelta });
      return value;
    };
    const pager = new RecordsetPager({ offset: 0, limit: 10 });
    feed(
      pager,
      [
        { name: 'id', index: 0, type: sql.Int },
        { name: 'd2', index: 1, type: sql.DateTime2, scale: 7 },
        { name: 'd0', index: 2, type: sql.DateTime2, scale: 0 },
        { name: 'dt', index: 3, type: sql.DateTime, scale: undefined },
        { name: 'v', index: 4, type: sql.Variant },
      ],
      [
        [1, at(123, 0.0004567), at(0), at(123), at(500)],
        [2, null, null, null, null],
      ]
    );
    const [rs] = pager.recordsets();
    expect(rs.rows[0].slice(0, 4)).toEqual([1, '2026-10-01T12:34:56.1234567', '2026-10-01T12:34:56', '2026-10-01T12:34:56.123']);
    expect(rs.rows[0][4]).toBeInstanceOf(Date);
    expect(toJsonSafe(rs.rows[0][4])).toBe('2026-10-01T12:34:56.5');
    expect(rs.rows[1]).toEqual([2, null, null, null, null]);
  });

  it('starts an implicit result set for rows without metadata', () => {
    const pager = new RecordsetPager({ offset: 0, limit: 10 });
    pager.addRow([1]);
    expect(pager.recordsets()).toEqual([{ columns: [], rows: [[1]], recordCount: 1, hasMore: false }]);
  });
});

describe('buildQueryResult', () => {
  it('summarises the page across result sets', () => {
    const window = { offset: 10, limit: 2 };
    const pager = new RecordsetPager(window);
    feed(pager, cols('n'), Array.from({ length: 13 }, (_, i) => [i]));
    const result = buildQueryResult(pager, window);
    expect(result.pagination).toEqual({ offset: 10, limit: 2, hasMore: true, nextOffset: 12, returnedRowCount: 2 });
    expect(result.recordsets[0].rows).toEqual([[10], [11]]);
  });

  it('omits nextOffset on the last page', () => {
    const window = { offset: 0, limit: 5 };
    const pager = new RecordsetPager(window);
    feed(pager, cols('n'), [[1]]);
    expect(buildQueryResult(pager, window).pagination).toEqual({ offset: 0, limit: 5, hasMore: false, returnedRowCount: 1 });
  });
});

describe('toJsonSafe / toCompactJson', () => {
  it('renders Buffers as hex', () => {
    expect(toJsonSafe(Buffer.from([0x00, 0xab, 0x10]))).toBe('0x00AB10');
  });

  it('truncates long binary values and reports their length', () => {
    const long = Buffer.alloc(MAX_BINARY_OUTPUT_BYTES + 10, 0xff);
    const text = toJsonSafe(long) as string;
    expect(text.startsWith('0x' + 'FF'.repeat(MAX_BINARY_OUTPUT_BYTES))).toBe(true);
    expect(text.endsWith(`... (${MAX_BINARY_OUTPUT_BYTES + 10} bytes)`)).toBe(true);
  });

  it('renders Dates of unknown type as date-and-time text without a zone, and invalid dates as null', () => {
    expect(toJsonSafe(new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6)))).toBe('2024-01-02T03:04:05.006');
    expect(toJsonSafe(new Date('nope'))).toBeNull();
  });

  it('renders BigInt as a decimal string', () => {
    expect(toJsonSafe(9007199254740993n)).toBe('9007199254740993');
  });

  it('converts nested rows and produces compact JSON', () => {
    const result = { recordsets: [{ columns: ['b', 'd', 'n'], rows: [[Buffer.from([1]), new Date(0), 1n]] }] };
    expect(toCompactJson(result)).toBe('{"recordsets":[{"columns":["b","d","n"],"rows":[["0x01","1970-01-01T00:00:00","1"]]}]}');
  });

  it('leaves plain values alone', () => {
    expect(toJsonSafe({ a: 1, b: 'x', c: null, d: true })).toEqual({ a: 1, b: 'x', c: null, d: true });
  });
});
