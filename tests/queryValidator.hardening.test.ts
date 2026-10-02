import { afterEach, describe, expect, it, vi } from 'vitest';
import nodeSqlParser from 'node-sql-parser';
import { validateReadOnlyQuery, type ReadOnlyQueryOptions } from '../queryValidator.js';
import { ErrorType, MssqlMcpError } from '../errors.js';

const NO_WHITELIST: ReadOnlyQueryOptions = { allowedDatabases: [] };
const ONE_DATABASE: ReadOnlyQueryOptions = { allowedDatabases: ['mydb'] };

// Builds a string from code points, so invisible or look-alike characters stay readable in source.
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);
const FULLWIDTH_SELECT = cp(0xff33, 0xff25, 0xff2c, 0xff25, 0xff23, 0xff34);

function rejectionOf(query: string, options: ReadOnlyQueryOptions = NO_WHITELIST): MssqlMcpError {
  try {
    validateReadOnlyQuery(query, options);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(MssqlMcpError);
    return error as MssqlMcpError;
  }
  throw new Error(`Expected the query to be rejected: ${JSON.stringify(query)}`);
}

function reasonFor(query: string, options: ReadOnlyQueryOptions = NO_WHITELIST): string {
  try {
    validateReadOnlyQuery(query, options);
  } catch (error: unknown) {
    return String((error as MssqlMcpError).details?.reason);
  }
  return 'allowed';
}

describe('a second statement without ";" is caught by the lexer', () => {
  // T-SQL needs no ";" between statements; each of these is two statements in SQL Server.
  it.each([
    'SELECT 1 SELECT 2',
    "SELECT 'A'SELECT 'B'",
    'SELECT [a]SELECT 2',
    'SELECT 1 /**/SELECT 2',
    'SELECT 1 FROM t SELECT 2',
    'SELECT a FROM t UNION SELECT a FROM u SELECT 2',
    'WITH c AS (SELECT 1 AS a) SELECT a FROM c SELECT 2',
    'SELECT 1 AS a WITH c AS (SELECT 2 AS b) SELECT b FROM c',
    'SELECT 1 FROM t WITH ROLLUP AS (SELECT 1) SELECT 2',
    'SELECT 1 FROM t WITH CUBE (a) AS (SELECT 1) SELECT 2',
    'SELECT 1 WITH TIES AS (SELECT 1) SELECT 2',
    'SELECT a FROM t WITH TIES ORDER BY a',
    'SELECT 1 x (SELECT 2)',
    'SELECT 1 x ((SELECT 2))',
    "SELECT 'a' (SELECT 2)",
    'SELECT * FROM t WITH (NOLOCK) (SELECT 1)',
    'SELECT CASE WHEN 1 = 1 THEN 1 END (SELECT 2)',
    'SELECT 1 AS apply (SELECT 2)',
    'SELECT 1 AS next (SELECT 2)',
    'SELECT 1 WHERE 1 IN (1) (SELECT 2)',
    '(SELECT 1) (SELECT 2)',
    'SELECT 1 OPTION (MAXDOP 1) (SELECT 2)',
    'SELECT t.* (SELECT 1) FROM t',
    'SELECT * (SELECT 1) FROM t',
    'SELECT 1 x (WITH c AS (SELECT 1) SELECT 2)',
    // A keyword that forms a whole expression, a variable or a bracketed name is not called.
    'SELECT NULL (SELECT 2)',
    'SELECT CURRENT_USER (SELECT 2)',
    'SELECT USER ((SELECT 2))',
    'SELECT CURRENT_TIMESTAMP ((SELECT 2))',
    'SELECT @@ROWCOUNT (SELECT 2)',
    'SELECT [x] ((SELECT 2))',
    'SELECT 1 AS x ((SELECT 2))',
    'SELECT 1 AS a WHERE 1 = 1 (SELECT 2)',
    'SELECT {fn UCASE(a)} (SELECT 2) FROM t',
    'SELECT 1 FETCH NEXT FROM c',
    'SELECT 1 AS rows FETCH NEXT FROM c',
    `SELECT 1 x ${FULLWIDTH_SELECT} 2`,
    `SELECT 1 x S${cp(0x0301)}ELECT 2`,
  ])('rejects %j', (query) => {
    const error = rejectionOf(query);
    expect(error.errorType).toBe(ErrorType.VALIDATION_ERROR);
    expect(error.details?.reason).toBe('multiple_statements');
  });

  it('names the second statement in the message', () => {
    expect(rejectionOf("SELECT 'A'SELECT 'B'").message).toMatch(/second statement/);
    expect(rejectionOf('SELECT 1 x (SELECT 2)').message).toMatch(/follows "x"/);
  });

  it.each(['SELECT 1)', 'SELECT (1', 'SELECT ((1)', '(SELECT 1'])('rejects unbalanced parentheses in %j', (query) => {
    expect(reasonFor(query)).toBe('unbalanced_parentheses');
  });

  it.each([
    'SELECT a FROM t UNION SELECT a FROM u',
    'SELECT a FROM t UNION ALL SELECT a FROM u',
    '(SELECT a FROM t) UNION (SELECT a FROM u)',
    'SELECT a FROM t UNION ALL (SELECT a FROM u)',
    'SELECT (SELECT 1) AS a',
    'SELECT DISTINCT (SELECT 1) AS a',
    'SELECT a, (SELECT 1) AS b FROM t',
    'SELECT * FROM t WHERE a IN (SELECT a FROM u)',
    'SELECT * FROM t WHERE EXISTS (SELECT 1)',
    'SELECT * FROM t WHERE NOT EXISTS (SELECT 1)',
    'SELECT * FROM t WHERE a = (SELECT 1)',
    'SELECT * FROM t WHERE a > ALL (SELECT 1)',
    'SELECT * FROM t WHERE a = 1 AND (SELECT 1) = 1',
    'SELECT * FROM (SELECT 1 AS a) d',
    'SELECT * FROM t JOIN (SELECT 1 AS a) d ON 1 = 1',
    'SELECT * FROM t CROSS APPLY (SELECT 1 AS a) d',
    'SELECT * FROM t OUTER APPLY (SELECT 1 AS a) d',
    'SELECT * FROM t WITH (NOLOCK)',
    'SELECT * FROM t AS x WITH (NOLOCK)',
    'SELECT TRY_CAST((SELECT 1) AS int) AS a',
    'SELECT COALESCE((SELECT 1), 0) AS a',
    'SELECT ISNULL ((SELECT 1), 0) AS a',
    'SELECT a + ABS((SELECT 1)) AS b FROM t',
    'SELECT dbo.f((SELECT 1)) AS a',
    'SELECT * FROM t WHERE a = [dbo].[f]((SELECT 1))',
    'WITH c AS (SELECT 1 AS a) SELECT a FROM c',
    'WITH c (a) AS (SELECT 1), d AS (SELECT a FROM c) SELECT * FROM d',
    'SELECT TOP (1) (SELECT 1) AS a',
    'SELECT TOP 1 (SELECT 1) AS a',
    'SELECT 2 * (SELECT 1) AS a',
    'SELECT COUNT(*) * (SELECT 1) AS a FROM t',
    'SELECT CASE WHEN (SELECT 1) = 1 THEN (SELECT 2) ELSE (SELECT 3) END AS a',
    'SELECT * FROM t ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY',
    'SELECT 1 AS a WHERE 1 BETWEEN (SELECT 0) AND (SELECT 2)',
    'SELECT [SELECT], [WITH], [FETCH] FROM t',
  ])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).not.toThrow();
  });
});

describe('statement keywords with no use in a SELECT are denied', () => {
  it.each([
    ['SELECT 1 DISABLE TRIGGER tr ON t', 'DISABLE'],
    ['SELECT 1 ENABLE TRIGGER tr ON t', 'ENABLE'],
    ['SELECT 1 LINENO 5', 'LINENO'],
    ["SELECT 1 SETUSER 'u'", 'SETUSER'],
    ['SELECT 1 REVERT', 'REVERT'],
    ["SELECT 1 RAISERROR('x', 16, 1)", 'RAISERROR'],
    ["SELECT 1 PRINT 'x'", 'PRINT'],
    ["SELECT 1 THROW 50000, 'x', 1", 'THROW'],
    ['SELECT 1 GOTO l', 'GOTO'],
    ['SELECT 1 RETURN', 'RETURN'],
    ['SELECT 1 WHILE 1 = 1 SELECT 2', 'WHILE'],
    ['SELECT 1 IF 1 = 1 SELECT 2', 'IF'],
    ['SELECT 1 DEALLOCATE c', 'DEALLOCATE'],
    ['SELECT 1 CLOSE c', 'CLOSE'],
    ['SELECT 1 OPEN c', 'OPEN'],
  ])('rejects %j', (query, keyword) => {
    const error = rejectionOf(query);
    expect(error.details?.reason).toBe('denied_keyword');
    expect(error.details?.keyword).toBe(keyword);
  });

  it.each([
    'SELECT IIF(a = 1, 1, 0) AS a FROM t',
    "SELECT * FROM OPENJSON(N'[1]')",
    'SELECT [Disable], [Enable], [Open], [Close] FROM t',
    'SELECT IsEnabled, Opened FROM t',
  ])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).not.toThrow();
  });
});

describe('keyword matching', () => {
  it('denies keywords spelled with combining marks, as objects are matched', () => {
    const error = rejectionOf(`SELECT 1 DEL${cp(0x0300)}ETE FROM t`);
    expect(error.details?.reason).toBe('denied_keyword');
    expect(error.details?.keyword).toBe('DELETE');
    expect(reasonFor(`SELECT 1 G${cp(0x0301)}O`)).toBe('batch_separator');
  });

  // SQL Server runs a look-alike first word as a stored procedure call.
  it.each([`${FULLWIDTH_SELECT} 1`, `${cp(0x015a)}ELECT 1`, `S${cp(0x0301)}ELECT 1`, `WIT${cp(0x0397)} c AS (SELECT 1) SELECT 2`])(
    'only takes an ASCII SELECT or WITH as the first keyword: %j',
    (query) => {
      expect(reasonFor(query)).toBe('not_select');
    },
  );

  it('accepts any letter case for keywords', () => {
    expect(() => validateReadOnlyQuery('select a from t union all Select a From u', NO_WHITELIST)).not.toThrow();
  });
});

describe('database names in the whitelist check', () => {
  // SQL Server ignores trailing spaces in names, but not leading ones.
  it.each(['SELECT * FROM [mydb ].dbo.t', 'SELECT * FROM [mydb  ].dbo.t', 'SELECT x.a FROM [mydb ].[dbo].[t] x'])(
    'allows %j',
    (query) => {
      expect(() => validateReadOnlyQuery(query, ONE_DATABASE)).not.toThrow();
    },
  );

  it('keeps a padded name whose case differs outside the whitelist', () => {
    expect(reasonFor('SELECT * FROM [MyDb  ].dbo.t', ONE_DATABASE)).toBe('database_not_allowed');
  });

  it.each([
    'SELECT * FROM [ mydb ].dbo.t',
    'SELECT * FROM [ mydb].dbo.t',
    'SELECT * FROM [mydb\t].dbo.t',
    `SELECT * FROM [mydb${cp(0x3000)}].dbo.t`,
    `SELECT * FROM [mydb${cp(0x00a0)}].dbo.t`,
  ])('keeps %j outside the whitelist', (query) => {
    expect(reasonFor(query, ONE_DATABASE)).toBe('database_not_allowed');
  });
});

describe('database names in the query must match the allow-list spelling exactly', () => {
  const SALES: ReadOnlyQueryOptions = { allowedDatabases: ['Sales'] };

  it.each([
    'SELECT * FROM Sales.dbo.t',
    'SELECT * FROM [Sales].[dbo].[t]',
    'SELECT * FROM "Sales"..t',
    'SELECT * FROM [Sales ].dbo.t',
    "SELECT OBJECT_ID('Sales.dbo.t') AS a, OBJECT_ID('[Sales]..t') AS b, OBJECT_ID(N'\"Sales \".dbo.t') AS c",
    "SELECT DB_ID('Sales') AS a, DATABASEPROPERTYEX('Sales ', 'Status') AS b",
    "SELECT HAS_PERMS_BY_NAME('Sales', 'DATABASE', 'ANY') AS a",
    "SELECT * FROM CONTAINSTABLE(Sales.dbo.t, c, 'x') AS k",
  ])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, SALES)).not.toThrow();
  });

  it.each([
    ['SELECT * FROM SALES.dbo.t', 'SALES'],
    ['SELECT * FROM [sales].[dbo].[t]', 'sales'],
    ['SELECT * FROM "SaLeS".dbo.t', 'SaLeS'],
    ['SELECT * FROM sales..t', 'sales'],
    ['SELECT * FROM [SALES ].dbo.t', 'SALES '],
    ['SELECT a.x FROM t JOIN sales.dbo.u a ON 1 = 1', 'sales'],
    ["SELECT * FROM CONTAINSTABLE(SALES.dbo.t, c, 'x') AS k", 'SALES'],
    ['SELECT SALES.dbo.f(1) AS a', 'SALES'],
    ['SELECT [sales]..f(1) AS a', 'sales'],
    ['SELECT sales.$PARTITION.pf(1) AS p', 'sales'],
    ["SELECT OBJECT_ID('SALES.dbo.t') AS a", 'SALES'],
    ["SELECT OBJECT_ID('[sales]..t') AS a", 'sales'],
    ["SELECT COL_LENGTH(N'\"SALES\".dbo.t', 'c') AS a", 'SALES'],
    ["SELECT DB_ID('sales') AS a", 'sales'],
    ["SELECT DATABASEPROPERTYEX('SALES', 'Status') AS a", 'SALES'],
    ["SELECT HAS_PERMS_BY_NAME('sales', 'DATABASE', 'ANY') AS a", 'sales'],
    ["SELECT * FROM fn_my_permissions('SALES.dbo.t', 'OBJECT') AS p", 'SALES'],
  ])('rejects %j and names the spelling to use', (query, database) => {
    const error = rejectionOf(query, SALES);
    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.details).toMatchObject({ reason: 'database_not_allowed', database, allowedSpelling: 'Sales' });
    expect(error.message).toContain('use [Sales]');
  });

  it('gives no spelling advice for a database that is not on the list in any case', () => {
    const error = rejectionOf('SELECT * FROM other.dbo.t', SALES);
    expect(error.details?.reason).toBe('database_not_allowed');
    expect(error.details).not.toHaveProperty('allowedSpelling');
    expect(error.message).not.toContain('use [');
  });

  it('accepts any spelling without an allow-list', () => {
    expect(() => validateReadOnlyQuery("SELECT * FROM SALES.dbo.t WHERE OBJECT_ID('sales.dbo.t') > 0", NO_WHITELIST)).not.toThrow();
  });
});

describe('syntax the parser lacks, read through rewritten parser text', () => {
  it.each([
    'SELECT a FROM t EXCEPT SELECT a FROM u',
    'SELECT a FROM t INTERSECT SELECT a FROM u',
    '(SELECT a FROM t) EXCEPT (SELECT a FROM u)',
    "SELECT STRING_AGG(name, ',') WITHIN GROUP (ORDER BY name) AS a FROM t",
    "SELECT STRING_AGG(name, ',') AS a FROM t",
    'SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER (PARTITION BY y) AS p FROM t',
    'SELECT * FROM t OPTION (MAXDOP 1)',
    'SELECT * FROM t OPTION (MAXDOP 1, RECOMPILE);',
    '(SELECT a FROM t) OPTION (MAXDOP 1)',
    'SELECT TRY_CAST(x AS int) AS a FROM t',
    "SELECT GETDATE() AT TIME ZONE 'UTC'",
    "SELECT d AT TIME ZONE 'UTC' AT TIME ZONE 'Central European Standard Time' AS a FROM t",
    'SELECT {fn UCASE(a)} FROM t',
    "SELECT {fn UCASE('a')} AS a",
    'SELECT {fn CONCAT({fn UCASE(a)}, b)} AS a FROM t',
    'SELECT $PARTITION.pf(id) AS p FROM t',
    'SELECT TOP (10) WITH TIES * FROM t ORDER BY score',
    'SELECT TOP 10 WITH TIES * FROM t ORDER BY score',
    'SELECT TOP 10 PERCENT WITH TIES * FROM t ORDER BY score',
    'SELECT a, COUNT(*) AS n FROM t GROUP BY a WITH ROLLUP',
    'SELECT a, COUNT(*) AS n FROM t GROUP BY a WITH CUBE',
  ])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).not.toThrow();
    expect(() => validateReadOnlyQuery(query, ONE_DATABASE)).not.toThrow();
  });

  // The rewrites keep every table reference visible to the whitelist check.
  it.each([
    'SELECT a FROM mydb.dbo.t EXCEPT SELECT a FROM other.dbo.u',
    'SELECT a FROM other.dbo.t INTERSECT SELECT a FROM mydb.dbo.u',
    "SELECT STRING_AGG(a, ',') WITHIN GROUP (ORDER BY (SELECT TOP 1 b FROM other.dbo.u)) AS a FROM t",
    'SELECT TRY_CAST((SELECT TOP 1 b FROM other.dbo.u) AS int) AS a',
    'SELECT GETDATE() AT TIME ZONE (SELECT TOP 1 tz FROM other.dbo.u) AS a',
    'SELECT {fn UCASE((SELECT TOP 1 b FROM other.dbo.u))} AS a',
    'SELECT $PARTITION.pf((SELECT TOP 1 b FROM other.dbo.u)) AS a',
    'SELECT TOP (10) WITH TIES * FROM other.dbo.t ORDER BY a',
    'SELECT a FROM other.dbo.t GROUP BY a WITH ROLLUP',
    'SELECT * FROM other.dbo.t OPTION (MAXDOP 1)',
  ])('keeps %j outside the whitelist', (query) => {
    expect(reasonFor(query, ONE_DATABASE)).toBe('database_not_allowed');
  });

  it.each([
    'SELECT a INTO x FROM t EXCEPT SELECT a FROM u',
    'SELECT a FROM t EXCEPT DELETE FROM u',
    "SELECT {fn UCASE(a)} exec('x')",
    'SELECT TRY_CAST(x AS int) AS a UPDATE t SET a = 1',
  ])('still denies %j', (query) => {
    expect(reasonFor(query)).toBe('denied_keyword');
  });

  it.each([
    // Only a final OPTION clause without subqueries or 3-part names is blanked.
    'SELECT * FROM t OPTION (TABLE HINT (other.dbo.t, NOLOCK))',
    // $PARTITION is only rewritten without a database name, and only as one token.
    'SELECT mydb.$PARTITION.pf(1) AS p',
    'SELECT $ PARTITION.pf(1) AS p',
    // Other ODBC escapes are not rewritten.
    "SELECT {ts '2020-01-01 00:00:00'} AS a",
    // OPTION only as the last clause.
    'SELECT a FROM t OPTION (MAXDOP 1) UNION SELECT 1',
    // A FETCH after columns named offset and rows passes the lexer, not the parser.
    'SELECT 1 AS offset, 2 AS rows FETCH NEXT FROM c',
  ])('leaves %j to the parser, which rejects it', (query) => {
    const error = rejectionOf(query, ONE_DATABASE);
    expect(error.errorType).toBe(ErrorType.SQL_PARSER_ERROR);
  });

  it.each([
    ['SELECT other.$PARTITION.pf(1) AS p', 'other'],
    ['SELECT [other].$PARTITION.[pf](1) AS p', 'other'],
    ['SELECT "other" . /* c */ $PARTITION . pf (1) AS p', 'other'],
    ['SELECT * FROM t WHERE other.$partition.pf(t.a) = 1', 'other'],
  ])('checks the database of %j against the whitelist', (query, database) => {
    const error = rejectionOf(query, ONE_DATABASE);
    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.details).toMatchObject({ reason: 'database_not_allowed', database });
  });

  it('rejects a $PARTITION function name with 4 parts as a linked server', () => {
    expect(reasonFor('SELECT srv.mydb.$PARTITION.pf(1) AS p', ONE_DATABASE)).toBe('linked_server');
    expect(reasonFor('SELECT srv.mydb.$PARTITION.pf(1) AS p', NO_WHITELIST)).toBe('linked_server');
  });
});

describe('CAST to xml and similar types, and methods of CLR types', () => {
  it.each([
    "SELECT CAST(N'<a/>' AS xml) AS xcol",
    "SELECT CAST(N'<a/>' AS xml) AS xcol, CAST(1 AS sql_variant) AS v",
    'SELECT CAST(1 AS sql_variant) AS v',
    "SELECT TRY_CAST(N'<a/>' AS XML) AS x",
    "SELECT CONVERT(xml, N'<a/>') AS x, TRY_CONVERT(sql_variant, 1) AS v",
    "SELECT CAST(N'POINT(1 2)' AS geography) AS g, CAST(0x58 AS hierarchyid) AS h, CAST(0x00 AS geometry) AS m",
    "SELECT CAST(x AS xml).value('(/a)[1]', 'int') AS v FROM t",
    'SELECT geography::Point(47.6, -122.3, 4326) AS geo',
    'SELECT hierarchyid::GetRoot() AS h',
    "SELECT geometry::STGeomFromText('POINT (1 2)', 0) AS g",
    'SELECT GEOGRAPHY :: Point(1, 2, 4326) AS g',
    'SELECT geography::Point(47.6, -122.3, 4326).STAsText() AS wkt',
    'SELECT hierarchyid::GetRoot().GetDescendant(NULL, NULL).ToString() AS h',
    'SELECT geo.STAsText() AS wkt, h.ToString() AS hs FROM t',
    'SELECT a FROM t WHERE g.STDistance(geography::Point(1, 2, 4326)) < 10',
    'SELECT geography::Point((SELECT TOP 1 lat FROM t), 1, 4326) AS g',
    'SELECT geography::Point(1, 2, 4326) AS g FROM mydb.dbo.t',
  ])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).not.toThrow();
    expect(() => validateReadOnlyQuery(query, ONE_DATABASE)).not.toThrow();
  });

  it.each([
    'SELECT CAST((SELECT TOP 1 b FROM other.dbo.u) AS xml) AS x',
    "SELECT CAST(x AS xml).value('.', 'int') AS v FROM other.dbo.t",
    'SELECT geography::Point((SELECT TOP 1 b FROM other.dbo.u), 1, 4326) AS g',
    'SELECT geography::Point(1, 2, 4326) AS g FROM other.dbo.t',
    'SELECT f(1).Method(2) AS x FROM other.dbo.t',
  ])('keeps %j outside the whitelist', (query) => {
    expect(reasonFor(query, ONE_DATABASE)).toBe('database_not_allowed');
  });

  it.each([
    ['SELECT CAST(1 AS xml) AS x; DELETE FROM t', 'multiple_statements'],
    ['SELECT CAST(1 AS xml) AS x SELECT * FROM t', 'multiple_statements'],
    ['SELECT CAST(1 AS sql_variant) AS v DELETE FROM t', 'denied_keyword'],
    ['SELECT CAST(1 AS xml) AS x INSERT INTO t VALUES (1)', 'denied_keyword'],
    ['WITH c AS (SELECT CAST(1 AS xml) AS x) DELETE FROM c', 'denied_keyword'],
    ["SELECT CAST(x AS xml) AS v FROM OPENROWSET('SQLNCLI', 'a', 'b')", 'denied_keyword'],
    ['SELECT geography::Point(1, 2, 4326) AS g; UPDATE t SET a = 1', 'multiple_statements'],
    ['SELECT geography::Point(1, 2, 4326) AS g SELECT 1', 'multiple_statements'],
    ['SELECT geography::Point(1, 2, 4326) AS g (SELECT 1)', 'multiple_statements'],
    ['SELECT geography::Point(1, 2, 4326) g ((SELECT 1))', 'multiple_statements'],
    ['SELECT hierarchyid::GetRoot() AS h INTO dbo.x', 'denied_keyword'],
    ['SELECT geography::Point(1, 2, 4326) AS g EXEC sp_who', 'denied_keyword'],
    ['SELECT 1 AS a WHERE 1 = geography::Point(1, 2, 3).STAsText() UPDATE t SET a = 1', 'denied_keyword'],
    ['SELECT geography::Point(1, 2, 4326) AS g FROM t WITH (UPDLOCK)', 'denied_keyword'],
    ['SELECT geography::Point(1, 2, 4326) AS g FROM srv.other.dbo.t', 'linked_server'],
    ['SELECT * FROM ::fn_dblog(NULL, NULL)', 'denied_object'],
  ])('still rejects %j', (query, reason) => {
    expect(reasonFor(query, ONE_DATABASE)).toBe(reason);
  });

  it.each([
    // Only the system CLR types, outside a dotted name, with "::" written as one token.
    'SELECT x.geography::Point(1, 2, 4326) AS g FROM t x',
    'SELECT geography: :Point(1, 2, 4326) AS g',
    'SELECT dbo.mytype::Make(1) AS x',
    // Only a whole CAST target type is rewritten, not typed xml.
    'SELECT CAST(x AS xml(dbo.coll)) AS v FROM t',
  ])('leaves %j to the parser, which rejects it', (query) => {
    expect(rejectionOf(query).errorType).toBe(ErrorType.SQL_PARSER_ERROR);
  });
});

describe('parse errors name the unsupported syntax', () => {
  it.each([
    ['SELECT x.geography::Point(1, 2, 4326) AS g FROM t x', '"::" other than in a static method call'],
    ['SELECT mydb.dbo.f(1) AS a', '3-part names'],
    ['SELECT t.x.value(1) AS a FROM t', '3-part names'],
    ["SELECT TRY_PARSE('1' AS int) AS a", 'PARSE and TRY_PARSE'],
    ["SELECT PARSE('1' AS int USING 'en-US') AS a", 'PARSE and TRY_PARSE'],
    ["SELECT 1 AS a WHERE {d '2020-01-01'} > '2019-01-01'", 'ODBC escape sequences'],
    ["SELECT {ts '2020-01-01 00:00:00'} AS a", 'ODBC escape sequences'],
    ['SELECT other.$PARTITION.pf(1) AS p', '$PARTITION with a database name'],
    ['SELECT * FROM t TABLESAMPLE (10 PERCENT)', 'TABLESAMPLE'],
    ["WITH XMLNAMESPACES ('u' AS ns) SELECT 1 AS a", 'WITH XMLNAMESPACES'],
    ['SELECT a FROM t GROUP BY GROUPING SETS ((a), ())', 'GROUPING SETS'],
    ['SELECT * FROM CHANGETABLE(CHANGES t, 0) AS c', 'CHANGETABLE'],
    ['SELECT a FROM t WHERE a IS DISTINCT FROM b', 'IS [NOT] DISTINCT FROM'],
    ["SELECT * FROM OPENJSON(N'[]') WITH (a int)", 'OPENJSON ... WITH'],
    ['SELECT * FROM t OPTION (TABLE HINT (a.b.c, NOLOCK))', 'OPTION (...) other than'],
    ["SELECT a FROM t FOR JSON PATH, ROOT('x')", 'FOR JSON or FOR XML options'],
  ])('%j', (query, construct) => {
    const error = rejectionOf(query);
    expect(error.errorType).toBe(ErrorType.SQL_PARSER_ERROR);
    expect(error.details?.reason).toBe('parse_error');
    expect(error.message).toContain(construct);
    expect((error.details?.unsupported as string[]).some((text) => text.includes(construct))).toBe(true);
  });

  it('falls back to examples when no known construct is found', () => {
    const error = rejectionOf('SELECT TOP (@n) * FROM t');
    expect(error.details?.reason).toBe('parse_error');
    expect(error.details?.unsupported).toEqual([]);
    expect(error.message).toMatch(/for example 3-part function names/);
    expect(error.message).not.toMatch(/TRY_CAST|AT TIME ZONE|INTERSECT|WITHIN GROUP/);
  });
});

describe('system functions such as @@VERSION', () => {
  it.each([
    'SELECT @@VERSION AS v',
    'SELECT @@TRANCOUNT AS open_transactions, SYSDATETIMEOFFSET() AS now_utc',
    'SELECT @@ROWCOUNT r',
    'SELECT name FROM sys.databases WHERE database_id = @@SPID',
    'SELECT @@SERVERNAME',
  ])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).not.toThrow();
  });

  it.each([
    'SELECT @@VERSION AS v; DELETE FROM t',
    'SELECT @@VERSION AS v SELECT * FROM other.dbo.t',
    'SELECT @@VERSION AS v INTO dbo.x',
    'SELECT @@VERSION AS v FROM other.dbo.t',
  ])('still rejects %j', (query) => {
    expect(() => validateReadOnlyQuery(query, ONE_DATABASE)).toThrow();
  });
});

describe('with a database allow-list, names passed as strings to system functions', () => {
  it.each([
    "SELECT OBJECT_ID('mydb.dbo.t') AS a",
    "SELECT OBJECT_ID('[mydb].dbo.t') AS a",
    "SELECT OBJECT_ID(N'\"mydb\"..t') AS a",
    "SELECT OBJECT_ID('mydb .dbo.t') AS a",
    "SELECT OBJECT_ID('dbo.t') AS a, OBJECT_ID(N't', 'U') AS b, OBJECT_ID('..t') AS c",
    'SELECT DB_ID() AS a, DB_NAME() AS b',
    "SELECT DB_ID('mydb') AS a, DB_ID(N'mydb ') AS b",
    "SELECT DB_NAME(DB_ID('mydb')) AS a",
    'SELECT OBJECT_NAME(object_id) AS a, OBJECT_SCHEMA_NAME(object_id) AS b FROM sys.objects',
    'SELECT OBJECT_NAME(object_id, DB_ID()) AS a FROM sys.objects',
    "SELECT OBJECT_SCHEMA_NAME(object_id, DB_ID('mydb')) AS a FROM sys.objects",
    "SELECT DATABASEPROPERTYEX('mydb', 'Status') AS a, HAS_DBACCESS('mydb') AS b",
    "SELECT HAS_PERMS_BY_NAME('mydb', 'DATABASE', 'ANY') AS a, HAS_PERMS_BY_NAME('dbo.t', 'OBJECT', 'SELECT') AS b",
    "SELECT COL_LENGTH('dbo.t', 'c') AS a, COL_LENGTH('mydb.dbo.t', 'c') AS b",
    "SELECT COLUMNPROPERTY(OBJECT_ID('dbo.t'), 'c', 'IsIdentity') AS a",
    "SELECT FILEPROPERTY('mydb_log', 'SpaceUsed') AS a",
    // COLUMNPROPERTY and FILEPROPERTY resolve their first argument in the current database only.
    "SELECT COLUMNPROPERTY(c.object_id, c.name, 'IsIdentity') AS a FROM sys.columns c",
    "SELECT COLUMNPROPERTY(1, 'c', 'IsIdentity') AS a, COLUMNPROPERTY(@id, @c, @p) AS b",
    "SELECT FILEPROPERTY(name, 'SpaceUsed') AS a FROM sys.database_files",
    "SELECT FILEPROPERTY('other..f', 'SpaceUsed') AS a",
    // A NULL securable is the server, or the current database for the DATABASE class.
    "SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS a",
    "SELECT HAS_PERMS_BY_NAME(null, 'SERVER', 'VIEW SERVER STATE') AS a, HAS_PERMS_BY_NAME(NULL, 'DATABASE', 'ANY') AS b",
    "SELECT HAS_PERMS_BY_NAME(NULL, @class, 'ANY') AS a",
    "SELECT * FROM fn_my_permissions(NULL, 'SERVER') AS a",
    "SELECT * FROM sys.fn_my_permissions(NULL, 'DATABASE') AS a",
    "SELECT * FROM fn_my_permissions('dbo.t', 'OBJECT') AS a",
    "SELECT * FROM fn_my_permissions('mydb.dbo.t', 'OBJECT') AS a",
    "SELECT * FROM fn_my_permissions('mydb', 'DATABASE') AS a",
    "SELECT DATABASEPROPERTY('mydb', 'IsTruncLog') AS a",
    "SELECT sys.fn_hadr_is_primary_replica('mydb') AS a, sys.fn_hadr_backup_is_preferred_replica(N'mydb') AS b",
    "SELECT * FROM sys.fn_db_backup_file_snapshots('mydb') AS s",
    'SELECT * FROM sys.tables',
    'SELECT * FROM dbo.databases',
    'SELECT name AS databases FROM sys.tables',
    'SELECT * FROM #local',
  ])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, ONE_DATABASE)).not.toThrow();
  });

  it.each([
    ["SELECT OBJECT_ID('other.dbo.t') AS a", 'other'],
    ["SELECT OBJECT_ID(N'[other]..t') AS a", 'other'],
    ["SELECT OBJECT_ID('\"other\".dbo.t') AS a", 'other'],
    ["SELECT OBJECT_ID('[oth]]er].dbo.t') AS a", 'oth]er'],
    ["SELECT [OBJECT_ID]('other.dbo.t') AS a", 'other'],
    ["SELECT OBJECT_ID(/* c */ 'other.dbo.t') AS a", 'other'],
    ["SELECT DB_ID('other') AS a", 'other'],
    ["SELECT DB_ID('[mydb]') AS a", '[mydb]'],
    ["SELECT DB_ID(' mydb') AS a", ' mydb'],
    ["SELECT OBJECT_NAME(1, DB_ID('other')) AS a", 'other'],
    ["SELECT DATABASEPROPERTYEX('other', 'Status') AS a", 'other'],
    ["SELECT HAS_DBACCESS(N'other') AS a", 'other'],
    ["SELECT HAS_PERMS_BY_NAME('other', 'DATABASE', 'ANY') AS a", 'other'],
    ["SELECT HAS_PERMS_BY_NAME('other.dbo.t', 'OBJECT', 'SELECT') AS a", 'other'],
    ["SELECT COL_LENGTH('other.dbo.t', 'c') AS a", 'other'],
    ["SELECT COLUMNPROPERTY(OBJECT_ID('other.dbo.t'), 'c', 'IsIdentity') AS a", 'other'],
    ["SELECT * FROM fn_my_permissions('other.dbo.t', 'OBJECT') AS a", 'other'],
    ["SELECT * FROM sys.[fn_my_permissions]('[other]..t', N'OBJECT') AS a", 'other'],
    ["SELECT * FROM fn_my_permissions('other', 'DATABASE') AS a", 'other'],
    ["SELECT DATABASEPROPERTY('other', 'IsTruncLog') AS a", 'other'],
    ["SELECT sys.fn_hadr_is_primary_replica('other') AS a", 'other'],
    ["SELECT sys.fn_hadr_backup_is_preferred_replica(N'other') AS a", 'other'],
    ["SELECT * FROM sys.fn_db_backup_file_snapshots('other') AS s", 'other'],
  ])('rejects %j', (query, database) => {
    const error = rejectionOf(query, ONE_DATABASE);
    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.details).toMatchObject({ reason: 'database_not_allowed', database });
    expect(error.message).toMatch(/not in the list of databases/);
    expect(error.message).toMatch(/database allow-list/);
  });

  it.each([
    ["SELECT DB_ID('[mydb]') AS a", /must be the bare database name/],
    ["SELECT DATABASEPROPERTYEX(' mydb', 'Status') AS a", /must be the bare database name/],
    ["SELECT OBJECT_ID('other.dbo.t') AS a", /checked like names in the query/],
  ])('explains how %j was read', (query, message) => {
    expect(rejectionOf(query, ONE_DATABASE).message).toMatch(message);
  });

  it.each([
    'SELECT OBJECT_ID(name) AS a FROM t',
    'SELECT OBJECT_ID(@n) AS a',
    "SELECT OBJECT_ID('oth' + 'er.dbo.t') AS a",
    "SELECT OBJECT_ID(('other.dbo.t')) AS a",
    "SELECT OBJECT_ID(CONCAT('other', '.dbo.t')) AS a",
    "SELECT OBJECT_ID('[other.dbo.t') AS a",
    "SELECT OBJECT_ID('[other] .dbo.t') AS a",
    'SELECT DB_ID(name) AS a FROM t',
    'SELECT DB_NAME(5) AS a',
    'SELECT DB_NAME(database_id) AS a FROM sys.tables',
    'SELECT OBJECT_NAME(object_id, 5) AS a FROM sys.objects',
    'SELECT OBJECT_SCHEMA_NAME(object_id, database_id) AS a FROM t',
    "SELECT DATABASEPROPERTYEX(@db, 'Status') AS a",
    'SELECT HAS_DBACCESS(name) AS a FROM t',
    "SELECT HAS_PERMS_BY_NAME(name, 'DATABASE', 'ANY') AS a FROM t",
    "SELECT HAS_PERMS_BY_NAME('other', @class, 'ANY') AS a",
    "SELECT HAS_PERMS_BY_NAME(name, NULL, 'ANY') AS a FROM t",
    "SELECT HAS_PERMS_BY_NAME(name, 'OBJECT', 'SELECT') AS a FROM t",
    "SELECT HAS_PERMS_BY_NAME((NULL), 'DATABASE', 'ANY') AS a",
    "SELECT HAS_PERMS_BY_NAME(CAST(NULL AS nvarchar(128)), 'SERVER', 'VIEW SERVER STATE') AS a",
    "SELECT * FROM fn_my_permissions(name, 'OBJECT') AS p CROSS JOIN t",
    "SELECT * FROM fn_my_permissions('other', @class) AS p",
    "SELECT DATABASEPROPERTY(@db, 'IsTruncLog') AS a",
    'SELECT sys.fn_hadr_is_primary_replica(name) AS a FROM t',
    "SELECT COL_LENGTH(name, 'c') AS a FROM t",
    "SELECT COL_LENGTH(t.name, 'x') AS a FROM sys.tables t",
    // The object id may be any expression, but an OBJECT_ID call in it is still checked.
    "SELECT COLUMNPROPERTY(OBJECT_ID(name), 'c', 'IsIdentity') AS a FROM t",
  ])('rejects %j, whose database cannot be checked', (query) => {
    const error = rejectionOf(query, ONE_DATABASE);
    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.details?.reason).toBe('unverifiable_database_reference');
    expect(error.message).toMatch(/cannot be checked/);
    expect(error.message).toMatch(/database allow-list/);
  });

  it('rejects a 4-part name in a string as a linked server', () => {
    const error = rejectionOf("SELECT OBJECT_ID('srv.mydb.dbo.t') AS a", ONE_DATABASE);
    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.details?.reason).toBe('linked_server');
  });
});

describe('with a database allow-list, server-wide views', () => {
  const SERVER_WIDE_QUERIES: Array<[string, string]> = [
    ['SELECT * FROM sys.fn_virtualfilestats(NULL, NULL)', 'fn_virtualfilestats'],
    ['SELECT * FROM sys.dm_os_performance_counters', 'dm_os_performance_counters'],
    ['SELECT * FROM sys.dm_tran_locks', 'dm_tran_locks'],
    ['SELECT * FROM sys.sysprocesses', 'sysprocesses'],
    ['SELECT * FROM sys.database_mirroring', 'database_mirroring'],
    ['SELECT * FROM sys.database_recovery_status', 'database_recovery_status'],
    ['SELECT * FROM sys.dm_database_encryption_keys', 'dm_database_encryption_keys'],
    ['SELECT * FROM sys.dm_hadr_database_replica_states', 'dm_hadr_database_replica_states'],
    ['SELECT * FROM sys.dm_tran_database_transactions', 'dm_tran_database_transactions'],
    ['SELECT * FROM sys.dm_tran_version_store', 'dm_tran_version_store'],
    ['SELECT * FROM sys.dm_fts_active_catalogs', 'dm_fts_active_catalogs'],
    ['SELECT * FROM sys.syslockinfo', 'syslockinfo'],
    ['SELECT * FROM sys.syscacheobjects', 'syscacheobjects'],
    ['SELECT * FROM sys.sysperfinfo', 'sysperfinfo'],
    ['SELECT * FROM sys.database_mirroring_witnesses', 'database_mirroring_witnesses'],
    ['SELECT * FROM sys.availability_databases_cluster', 'availability_databases_cluster'],
    ['SELECT * FROM sys.dm_db_mirroring_auto_page_repair', 'dm_db_mirroring_auto_page_repair'],
    ['SELECT * FROM sys.dm_os_buffer_pool_extension_pages', 'dm_os_buffer_pool_extension_pages'],
    ['SELECT * FROM sys.dm_os_volume_stats(1, 1)', 'dm_os_volume_stats'],
    ['SELECT * FROM sys.dm_os_waiting_tasks', 'dm_os_waiting_tasks'],
    ['SELECT * FROM sys.dm_broker_activated_tasks', 'dm_broker_activated_tasks'],
    ['SELECT * FROM sys.dm_broker_queue_monitors', 'dm_broker_queue_monitors'],
    ['SELECT * FROM sys.dm_clr_appdomains', 'dm_clr_appdomains'],
    ['SELECT * FROM sys.dm_qn_subscriptions', 'dm_qn_subscriptions'],
    ['SELECT * FROM sys.dm_server_suspend_status', 'dm_server_suspend_status'],
    ['SELECT * FROM sys.fn_get_sql(0x01)', 'fn_get_sql'],
    ['SELECT * FROM sys.dm_hadr_availability_replica_states', 'dm_hadr_availability_replica_states'],
    ['SELECT * FROM sys.dm_tran_active_transactions', 'dm_tran_active_transactions'],
    ['SELECT * FROM sys.dm_fts_index_population', 'dm_fts_index_population'],
  ];

  it.each([
    ['SELECT name FROM sys.databases', 'sys.databases'],
    ['SELECT name FROM [sys].[databases]', 'sys.databases'],
    ['SELECT name FROM "sys"."databases"', 'sys.databases'],
    ['SELECT name FROM sys . /* c */ [DATABASES]', 'sys.databases'],
    ['SELECT * FROM sysdatabases', 'sysdatabases'],
    ['SELECT * FROM dbo.sysdatabases', 'sysdatabases'],
    ['SELECT * FROM sys.master_files', 'master_files'],
    ['SELECT * FROM sys.sysaltfiles', 'sysaltfiles'],
    ['SELECT * FROM sys.dm_exec_sessions', 'dm_exec_sessions'],
    ['SELECT * FROM sys."dm_exec_sql_text"(0x01)', 'dm_exec_sql_text'],
    ['SELECT * FROM [sys].[DM_EXEC_CONNECTIONS]', 'DM_EXEC_CONNECTIONS'],
    ['SELECT * FROM sys.dm_xe_sessions', 'dm_xe_sessions'],
    ['SELECT * FROM sys.dm_db_index_usage_stats', 'dm_db_index_usage_stats'],
    ['SELECT * FROM sys.dm_db_index_physical_stats(NULL, NULL, NULL, NULL, NULL)', 'dm_db_index_physical_stats'],
    ['SELECT * FROM sys.dm_db_index_operational_stats(NULL, NULL, NULL, NULL)', 'dm_db_index_operational_stats'],
    ["SELECT * FROM sys.dm_db_page_info(1, 1, 1, 'DETAILED')", 'dm_db_page_info'],
    ["SELECT * FROM sys.dm_db_database_page_allocations(1, NULL, NULL, NULL, 'LIMITED')", 'dm_db_database_page_allocations'],
    ['SELECT * FROM sys.dm_db_log_info(1)', 'dm_db_log_info'],
    ['SELECT * FROM sys.dm_db_log_stats(1)', 'dm_db_log_stats'],
    ['SELECT * FROM sys.dm_db_missing_index_details', 'dm_db_missing_index_details'],
    ['SELECT * FROM sys.dm_io_virtual_file_stats(NULL, NULL)', 'dm_io_virtual_file_stats'],
    ['SELECT * FROM sys.dm_os_buffer_descriptors', 'dm_os_buffer_descriptors'],
    ...SERVER_WIDE_QUERIES,
    ['SELECT * FROM [sys].[fn_virtualfilestats](NULL, NULL)', 'fn_virtualfilestats'],
    ['SELECT * FROM "sys"."FN_VIRTUALFILESTATS"(NULL, NULL)', 'FN_VIRTUALFILESTATS'],
    ['SELECT * FROM [sys].[dm_os_performance_counters]', 'dm_os_performance_counters'],
    ['SELECT * FROM "sys"."dm_os_performance_counters"', 'dm_os_performance_counters'],
    ['SELECT * FROM [sys].[DM_TRAN_LOCKS]', 'DM_TRAN_LOCKS'],
    ['SELECT * FROM "sys"."dm_tran_locks"', 'dm_tran_locks'],
    ['SELECT * FROM [sys].[sysprocesses]', 'sysprocesses'],
    ['SELECT * FROM "sys"."sysprocesses"', 'sysprocesses'],
    ['SELECT * FROM dbo.sysprocesses', 'sysprocesses'],
    ['SELECT * FROM [sys].[database_mirroring]', 'database_mirroring'],
    ['SELECT * FROM "sys"."Database_Recovery_Status"', 'Database_Recovery_Status'],
    ['SELECT * FROM [sys].[dm_database_encryption_keys]', 'dm_database_encryption_keys'],
    ['SELECT * FROM "sys"."dm_hadr_database_replica_states"', 'dm_hadr_database_replica_states'],
    ['SELECT * FROM [sys].[dm_tran_database_transactions]', 'dm_tran_database_transactions'],
    ['SELECT * FROM "sys"."dm_tran_version_store"', 'dm_tran_version_store'],
    ['SELECT * FROM [sys].[dm_fts_active_catalogs]', 'dm_fts_active_catalogs'],
    ['SELECT * FROM "sys"."syslockinfo"', 'syslockinfo'],
    ['SELECT * FROM [sys].[syscacheobjects]', 'syscacheobjects'],
    ['SELECT * FROM [sys].[dm_os_waiting_tasks]', 'dm_os_waiting_tasks'],
    ['SELECT * FROM "sys"."fn_get_sql"(0x01)', 'fn_get_sql'],
  ])('rejects %j', (query, object) => {
    const error = rejectionOf(query, ONE_DATABASE);
    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.details).toMatchObject({ reason: 'server_scoped_object', object });
    expect(error.message).toMatch(/every database on the server/);
    expect(error.message).toMatch(/database allow-list/);
  });

  it.each(SERVER_WIDE_QUERIES)('allows %j without an allow-list', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).not.toThrow();
  });
});

describe('with a database allow-list, global temporary tables', () => {
  it.each(['SELECT * FROM ##g', 'SELECT * FROM [##g]', 'SELECT * FROM t JOIN "##g" ON 1 = 1', "SELECT OBJECT_ID('##g') AS a", "SELECT COL_LENGTH('dbo.##g', 'c') AS a"])(
    'rejects %j',
    (query) => {
      const error = rejectionOf(query, ONE_DATABASE);
      expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
      expect(error.details?.reason).toBe('global_temp_table');
      expect(error.message).toMatch(/tempdb/);
      expect(error.message).toMatch(/database allow-list/);
    },
  );

  it('rejects one named with tempdb by the 3-part name check', () => {
    expect(reasonFor('SELECT * FROM tempdb..##g', ONE_DATABASE)).toBe('database_not_allowed');
  });

  it.each(['SELECT * FROM ##g', 'SELECT * FROM tempdb..##g', "SELECT OBJECT_ID('tempdb..##g') AS a"])('allows %j when tempdb is on the list', (query) => {
    expect(() => validateReadOnlyQuery(query, { allowedDatabases: ['mydb', 'tempdb'] })).not.toThrow();
  });
});

describe('without a database allow-list, indirect references are not restricted', () => {
  it.each([
    "SELECT OBJECT_ID('other.dbo.t') AS a, OBJECT_ID(name) AS b FROM t",
    "SELECT DB_ID('other') AS a, DB_NAME(5) AS b, OBJECT_NAME(1, 5) AS c",
    "SELECT DATABASEPROPERTYEX('other', 'Status') AS a, HAS_DBACCESS('other') AS b",
    "SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS a",
    "SELECT COL_LENGTH('other.dbo.t', 'c') AS a, COLUMNPROPERTY(1, 'c', 'IsIdentity') AS b, FILEPROPERTY(name, 'SpaceUsed') AS c FROM t",
    'SELECT name FROM sys.databases',
    'SELECT name FROM [sys].[databases]',
    'SELECT * FROM sys.dm_exec_sessions',
    'SELECT * FROM sys.dm_exec_requests r CROSS APPLY sys."dm_exec_sql_text"(r.sql_handle) s',
    'SELECT * FROM sys.master_files',
    'SELECT * FROM ##g',
  ])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).not.toThrow();
  });
});

describe('3-part functions and table hints in other databases', () => {
  // Checked on the tokens before the parser runs, so the result does not depend on whether
  // the parser can read 3-part function names.
  it.each([
    ['SELECT * FROM other.dbo.tvf(1)', 'other'],
    ['SELECT * FROM t a CROSS APPLY other.dbo.f(a.x)', 'other'],
    ['SELECT * FROM t a OUTER APPLY other.dbo.f(a.x) AS f', 'other'],
    ['SELECT other.dbo.scalarfn(1) AS a', 'other'],
    ['SELECT a FROM t WHERE other.dbo.scalarfn(a) = 1', 'other'],
    ['SELECT [other].[dbo].[f](1) AS a', 'other'],
    ['SELECT "other"."dbo"."f"(1) AS a', 'other'],
    ['SELECT [oth]]er].dbo.f(1) AS a', 'oth]er'],
    ['SELECT other . /* c */ dbo . f (1) AS a', 'other'],
    ['SELECT other\n.dbo -- c\n.f\n(1) AS a', 'other'],
    ['SELECT other..f(1) AS a', 'other'],
    ['SELECT * FROM [other]..tvf(1)', 'other'],
    ['SELECT [ mydb].dbo.f(1) AS a', ' mydb'],
    ['SELECT * FROM other.dbo.t(NOLOCK)', 'other'],
    ['SELECT * FROM other.dbo.t WITH (NOLOCK)', 'other'],
  ])('rejects %j', (query, database) => {
    const error = rejectionOf(query, ONE_DATABASE);
    expect(error.errorType).toBe(ErrorType.PERMISSION_ERROR);
    expect(error.details).toMatchObject({ reason: 'database_not_allowed', database });
    expect(error.message).toMatch(/not in the list of databases/);
  });

  // An allowed database passes the token check; the parser then rejects the 3-part name.
  it.each([
    'SELECT mydb.dbo.f(1) AS a',
    'SELECT [mydb].[dbo].[f](1) AS a',
    'SELECT [mydb ].dbo.f(1) AS a',
    'SELECT * FROM mydb..tvf(1)',
    'SELECT * FROM t a CROSS APPLY mydb.dbo.f(a.x) y',
  ])('leaves %j in an allowed database to the parser, which rejects it', (query) => {
    expect(reasonFor(query, ONE_DATABASE)).toBe('parse_error');
  });

  it.each(['SELECT dbo.f(1) AS a, f(2) AS b', 'SELECT * FROM mydb.dbo.t (NOLOCK)'])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, ONE_DATABASE)).not.toThrow();
  });

  it.each(['SELECT * FROM other.dbo.tvf(1)', 'SELECT other.dbo.scalarfn(1) AS a', 'SELECT other..f(1) AS a'])(
    'leaves %j to the parser without an allow-list',
    (query) => {
      expect(reasonFor(query, NO_WHITELIST)).toBe('parse_error');
    },
  );
});

describe('a parser result with more than one statement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is reported as a parser problem, not as two statements sent by the caller', () => {
    const real = nodeSqlParser.Parser.prototype.astify;
    vi.spyOn(nodeSqlParser.Parser.prototype, 'astify').mockImplementation(function (this: unknown, ...args: unknown[]) {
      const ast = (real as (...a: unknown[]) => unknown).apply(this, args);
      return [ast, ast] as never;
    });
    const error = rejectionOf('SELECT a FROM t');
    expect(error.errorType).toBe(ErrorType.SQL_PARSER_ERROR);
    expect(error.details?.reason).toBe('parse_error');
    expect(error.details?.statementCount).toBe(2);
    expect(error.message).toMatch(/although it is a single statement/);
  });
});
