import { describe, expect, it } from 'vitest';
import { SCHEMA_QUERY, buildTableSchemas, type ForeignKeyRow, type SchemaColumnRow } from '../schemaModel.js';

function column(table: string, name: string, extra: Partial<SchemaColumnRow> = {}): SchemaColumnRow {
  const [schema, tableName] = table.split('.');
  return {
    TABLE_SCHEMA: schema,
    TABLE_NAME: tableName,
    TABLE_TYPE: 'BASE TABLE',
    COLUMN_NAME: name,
    DATA_TYPE: 'int',
    CHARACTER_MAXIMUM_LENGTH: null,
    NUMERIC_PRECISION: null,
    NUMERIC_SCALE: null,
    IS_NULLABLE: 'NO',
    IS_PRIMARY_KEY: 0,
    ORDINAL_POSITION: 1,
    ...extra,
  };
}

describe('SCHEMA_QUERY', () => {
  it('joins primary keys on constraint schema and name, and includes views', () => {
    expect(SCHEMA_QUERY).toContain('tc.CONSTRAINT_SCHEMA = ku.CONSTRAINT_SCHEMA');
    expect(SCHEMA_QUERY).toContain('tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME');
    expect(SCHEMA_QUERY).toContain("TABLE_TYPE IN ('BASE TABLE', 'VIEW')");
    expect(SCHEMA_QUERY).toContain('sys.foreign_keys');
  });

  it('only reads', () => {
    expect(SCHEMA_QUERY).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|INTO|CREATE|ALTER|DROP)\b/i);
  });
});

describe('buildTableSchemas', () => {
  it('groups columns into tables and views with formatted types', () => {
    const tables = buildTableSchemas([
      column('dbo.Orders', 'Id', { IS_PRIMARY_KEY: 1 }),
      column('dbo.Orders', 'Note', { DATA_TYPE: 'nvarchar', CHARACTER_MAXIMUM_LENGTH: -1, IS_NULLABLE: 'YES' }),
      column('dbo.Orders', 'Total', { DATA_TYPE: 'decimal', NUMERIC_PRECISION: 18, NUMERIC_SCALE: 2 }),
      column('rpt.OrderSummary', 'Total', { TABLE_TYPE: 'VIEW' }),
    ]);
    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ fullName: 'dbo.Orders', type: 'table', foreignKeys: [] });
    expect(tables[0].columns).toEqual([
      { name: 'Id', type: 'int', nullable: false, primary: true },
      { name: 'Note', type: 'nvarchar(max)', nullable: true, primary: false },
      { name: 'Total', type: 'decimal(18,2)', nullable: false, primary: false },
    ]);
    expect(tables[1]).toMatchObject({ fullName: 'rpt.OrderSummary', type: 'view' });
  });

  it('attaches multi-column foreign keys to their table', () => {
    const fk = (col: string, ref: string, ordinal: number): ForeignKeyRow => ({
      FK_NAME: 'FK_Lines_Orders',
      TABLE_SCHEMA: 'dbo',
      TABLE_NAME: 'Lines',
      COLUMN_NAME: col,
      REFERENCED_SCHEMA: 'dbo',
      REFERENCED_TABLE: 'Orders',
      REFERENCED_COLUMN: ref,
      ORDINAL: ordinal,
    });
    const tables = buildTableSchemas([column('dbo.Lines', 'OrderId'), column('dbo.Lines', 'Region')], [fk('OrderId', 'Id', 1), fk('Region', 'Region', 2)]);
    expect(tables[0].foreignKeys).toEqual([
      { name: 'FK_Lines_Orders', columns: ['OrderId', 'Region'], referencedTable: 'dbo.Orders', referencedColumns: ['Id', 'Region'] },
    ]);
  });
});
