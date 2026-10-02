export interface ForeignKeySchema {
  name: string;
  columns: string[];
  /** `schema.table` of the referenced table. */
  referencedTable: string;
  referencedColumns: string[];
}

export interface TableSchema {
  schema: string;
  name: string;
  fullName: string;
  type: 'table' | 'view';
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    primary: boolean;
  }>;
  foreignKeys: ForeignKeySchema[];
}

export interface SchemaColumnRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_TYPE: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  NUMERIC_PRECISION: number | null;
  NUMERIC_SCALE: number | null;
  IS_NULLABLE: 'YES' | 'NO';
  IS_PRIMARY_KEY: 0 | 1;
  ORDINAL_POSITION: number;
}

export interface ForeignKeyRow {
  FK_NAME: string;
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_SCHEMA: string;
  REFERENCED_TABLE: string;
  REFERENCED_COLUMN: string;
  ORDINAL: number;
}

/** Read-only catalog batch: columns of tables and views, then foreign key columns. */
export const SCHEMA_QUERY = `
SELECT
    t.TABLE_SCHEMA,
    t.TABLE_NAME,
    t.TABLE_TYPE,
    c.COLUMN_NAME,
    c.DATA_TYPE,
    c.CHARACTER_MAXIMUM_LENGTH,
    c.NUMERIC_PRECISION,
    c.NUMERIC_SCALE,
    c.IS_NULLABLE,
    CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY,
    c.ORDINAL_POSITION
FROM INFORMATION_SCHEMA.TABLES t
INNER JOIN INFORMATION_SCHEMA.COLUMNS c
    ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
LEFT JOIN (
    SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc
    INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS ku
        ON tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND tc.CONSTRAINT_SCHEMA = ku.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
) pk ON c.TABLE_SCHEMA = pk.TABLE_SCHEMA AND c.TABLE_NAME = pk.TABLE_NAME AND c.COLUMN_NAME = pk.COLUMN_NAME
WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION;

SELECT
    fk.name AS FK_NAME,
    SCHEMA_NAME(pt.schema_id) AS TABLE_SCHEMA,
    pt.name AS TABLE_NAME,
    pc.name AS COLUMN_NAME,
    SCHEMA_NAME(rt.schema_id) AS REFERENCED_SCHEMA,
    rt.name AS REFERENCED_TABLE,
    rc.name AS REFERENCED_COLUMN,
    fkc.constraint_column_id AS ORDINAL
FROM sys.foreign_keys fk
INNER JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
INNER JOIN sys.objects pt ON pt.object_id = fkc.parent_object_id
INNER JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
INNER JOIN sys.objects rt ON rt.object_id = fkc.referenced_object_id
INNER JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
ORDER BY TABLE_SCHEMA, TABLE_NAME, FK_NAME, ORDINAL;
`;

function formatColumnType(row: SchemaColumnRow): string {
  if (row.CHARACTER_MAXIMUM_LENGTH) {
    return `${row.DATA_TYPE}(${row.CHARACTER_MAXIMUM_LENGTH === -1 ? 'max' : row.CHARACTER_MAXIMUM_LENGTH})`;
  }
  if (row.NUMERIC_PRECISION !== null && row.NUMERIC_SCALE !== null) {
    return `${row.DATA_TYPE}(${row.NUMERIC_PRECISION},${row.NUMERIC_SCALE})`;
  }
  return row.DATA_TYPE;
}

/** Groups catalog rows into one entry per table or view, with its columns and foreign keys. */
export function buildTableSchemas(columnRows: readonly SchemaColumnRow[], foreignKeyRows: readonly ForeignKeyRow[] = []): TableSchema[] {
  const tables = new Map<string, TableSchema>();

  for (const row of columnRows) {
    const fullName = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
    let table = tables.get(fullName);
    if (!table) {
      table = {
        schema: row.TABLE_SCHEMA,
        name: row.TABLE_NAME,
        fullName,
        type: row.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
        columns: [],
        foreignKeys: [],
      };
      tables.set(fullName, table);
    }
    table.columns.push({
      name: row.COLUMN_NAME,
      type: formatColumnType(row),
      nullable: row.IS_NULLABLE === 'YES',
      primary: row.IS_PRIMARY_KEY === 1,
    });
  }

  for (const row of foreignKeyRows) {
    const table = tables.get(`${row.TABLE_SCHEMA}.${row.TABLE_NAME}`);
    if (!table) continue;
    let foreignKey = table.foreignKeys.find((fk) => fk.name === row.FK_NAME);
    if (!foreignKey) {
      foreignKey = { name: row.FK_NAME, columns: [], referencedTable: `${row.REFERENCED_SCHEMA}.${row.REFERENCED_TABLE}`, referencedColumns: [] };
      table.foreignKeys.push(foreignKey);
    }
    foreignKey.columns.push(row.COLUMN_NAME);
    foreignKey.referencedColumns.push(row.REFERENCED_COLUMN);
  }

  return Array.from(tables.values());
}
