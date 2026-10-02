import { formatTemporalValue, formatUntypedDate, temporalColumnFromType, type TemporalColumn } from './temporalFormat.js';

/** A result set as returned to MCP clients: column names plus positional rows. */
export interface Recordset {
  columns: string[];
  rows: unknown[][];
  recordCount: number;
  /** True when the result set had more rows than were returned. */
  hasMore: boolean;
  /** Offset to request for the next page of this result set, when paging and `hasMore` is true. */
  nextOffset?: number;
}

export interface PageWindow {
  offset: number;
  limit: number;
}

/**
 * Resolves the requested page against the server's row cap: `limit` defaults to and
 * may never exceed `maxRows`, and `offset` defaults to 0.
 */
export function resolvePageWindow(offset: number | undefined, limit: number | undefined, maxRows: number): PageWindow {
  const cap = Number.isFinite(maxRows) && maxRows >= 1 ? Math.floor(maxRows) : 1;
  const requested = limit !== undefined && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : cap;
  const start = offset !== undefined && Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  return { offset: start, limit: Math.min(requested, cap) };
}

interface ColumnInfo {
  name: string;
  /** Set for date/time columns, whose values are rendered as SQL text. */
  temporal: TemporalColumn | null;
}

/**
 * Reads columns, in column order, from driver column metadata: an array of
 * `{ name, index, type, scale }` objects (array row mode) or an object keyed by column name.
 */
function columnsFromMetadata(columns: unknown): ColumnInfo[] {
  if (columns === null || typeof columns !== 'object') return [];
  const list = (Array.isArray(columns) ? columns : Object.values(columns)) as Array<{ name?: unknown; index?: unknown; type?: unknown; scale?: unknown } | null>;
  return list
    .map((column, position) => ({
      name: typeof column?.name === 'string' ? column.name : '',
      index: typeof column?.index === 'number' ? column.index : position,
      temporal: temporalColumnFromType(column?.type, column?.scale),
    }))
    .sort((a, b) => a.index - b.index)
    .map(({ name, temporal }) => ({ name, temporal }));
}

/**
 * Reads column names, in column order, from driver column metadata: an array of
 * `{ name, index }` objects (array row mode) or an object keyed by column name.
 * Unnamed columns become "".
 */
export function columnNamesFromMetadata(columns: unknown): string[] {
  return columnsFromMetadata(columns).map((column) => column.name);
}

/** Turns a driver row into a positional array. Rows that arrive as objects keep their key order. */
export function rowToArray(row: unknown): unknown[] {
  if (Array.isArray(row)) return row;
  if (row !== null && typeof row === 'object') return Object.values(row);
  return [row];
}

/** Renders the values of date/time columns as SQL text; other values are left as they are. */
function formatRow(values: unknown[], temporal: ReadonlyArray<TemporalColumn | null>): unknown[] {
  if (!temporal.some((column) => column !== null)) return values;
  return values.map((value, index) => formatTemporalValue(value, temporal[index] ?? null));
}

interface RecordsetState {
  columns: string[];
  temporal: Array<TemporalColumn | null>;
  rows: unknown[][];
  seen: number;
  hasMore: boolean;
}

/**
 * Collects streamed rows into result sets, keeping for each result set only the rows
 * inside the page window. `addRow` returns true when the row just added is the first
 * one past the window, which is when the result set is known to have more rows.
 */
export class RecordsetPager {
  private readonly sets: RecordsetState[] = [];

  constructor(private readonly window: PageWindow, private readonly paged: boolean = true) {}

  startRecordset(columns: unknown): void {
    const info = columnsFromMetadata(columns);
    this.sets.push({ columns: info.map((c) => c.name), temporal: info.map((c) => c.temporal), rows: [], seen: 0, hasMore: false });
  }

  addRow(row: unknown): boolean {
    if (this.sets.length === 0) this.startRecordset([]);
    const current = this.sets[this.sets.length - 1];
    const position = current.seen++;
    const end = this.window.offset + this.window.limit;

    if (position < this.window.offset) return false;
    if (position < end) {
      current.rows.push(formatRow(rowToArray(row), current.temporal));
      return false;
    }
    if (position === end) {
      current.hasMore = true;
      return true;
    }
    return false;
  }

  /** Total rows kept across all result sets. */
  get returnedRowCount(): number {
    return this.sets.reduce((sum, set) => sum + set.rows.length, 0);
  }

  get anyHasMore(): boolean {
    return this.sets.some((set) => set.hasMore);
  }

  recordsets(): Recordset[] {
    return this.sets.map((set) => ({
      columns: set.columns,
      rows: set.rows,
      recordCount: set.rows.length,
      hasMore: set.hasMore,
      ...(this.paged && set.hasMore ? { nextOffset: this.window.offset + this.window.limit } : {}),
    }));
  }
}

export interface QueryPagination {
  offset: number;
  limit: number;
  /** True when any result set has more rows after this page. */
  hasMore: boolean;
  nextOffset?: number;
  /** Rows returned in this response, across all result sets. */
  returnedRowCount: number;
}

export interface QueryResult {
  recordsets: Recordset[];
  pagination: QueryPagination;
}

export function buildQueryResult(pager: RecordsetPager, window: PageWindow): QueryResult {
  const hasMore = pager.anyHasMore;
  return {
    recordsets: pager.recordsets(),
    pagination: {
      offset: window.offset,
      limit: window.limit,
      hasMore,
      ...(hasMore ? { nextOffset: window.offset + window.limit } : {}),
      returnedRowCount: pager.returnedRowCount,
    },
  };
}

/** Binary values longer than this many bytes are truncated in tool output. */
export const MAX_BINARY_OUTPUT_BYTES = 64;

function binaryToHex(bytes: Uint8Array): string {
  const shown = bytes.subarray(0, MAX_BINARY_OUTPUT_BYTES);
  let hex = '';
  for (const byte of shown) hex += byte.toString(16).padStart(2, '0').toUpperCase();
  return bytes.length > MAX_BINARY_OUTPUT_BYTES ? `0x${hex}... (${bytes.length} bytes)` : `0x${hex}`;
}

/**
 * Converts a value into something JSON can represent faithfully: binary values become
 * "0x..." hex strings (truncated past MAX_BINARY_OUTPUT_BYTES), and bigints become
 * decimal strings. Date/time values of known columns are already SQL text by this point;
 * any other Date (such as a sql_variant value) becomes date-and-time text from
 * `formatUntypedDate`, and invalid dates become null.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return binaryToHex(value);
  if (value instanceof Date) return formatUntypedDate(value);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toJsonSafe(entry);
    return out;
  }
  return value;
}

/** Serialises a tool result as compact JSON, with values converted by `toJsonSafe`. */
export function toCompactJson(value: unknown): string {
  return JSON.stringify(toJsonSafe(value)) ?? 'null';
}
