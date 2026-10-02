import { describe, expect, it } from 'vitest';
import { validateReadOnlyQuery, type ReadOnlyQueryOptions } from '../queryValidator.js';
import { ErrorType, MssqlMcpError } from '../errors.js';

const NO_WHITELIST: ReadOnlyQueryOptions = { allowedDatabases: [] };
const WHITELIST: ReadOnlyQueryOptions = { allowedDatabases: ['sales', 'reporting'] };

function rejectionOf(query: string, options: ReadOnlyQueryOptions = NO_WHITELIST): MssqlMcpError {
  try {
    validateReadOnlyQuery(query, options);
  } catch (error) {
    expect(error).toBeInstanceOf(MssqlMcpError);
    return error as MssqlMcpError;
  }
  throw new Error(`Expected the query to be rejected: ${query}`);
}

function expectRejected(query: string, errorType?: ErrorType, options: ReadOnlyQueryOptions = NO_WHITELIST): MssqlMcpError {
  const error = rejectionOf(query, options);
  if (errorType !== undefined) expect(error.errorType).toBe(errorType);
  return error;
}

function expectAccepted(query: string, options: ReadOnlyQueryOptions = NO_WHITELIST): void {
  expect(() => validateReadOnlyQuery(query, options)).not.toThrow();
}

describe('validateReadOnlyQuery: rejects', () => {
  describe('backslash string bypasses', () => {
    it.each([
      "SELECT 'a\\' ; SELECT 2; --'",
      "SELECT 'a\\' ; SELECT 2 AS smuggled; --'",
      'SELECT "a\\" ; SELECT 2; --"',
      "SELECT 'a\\' ; DELETE FROM dbo.t; --'",
      "SELECT N'a\\' ; UPDATE t SET x = 1; --'",
    ])('%s', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });
  });

  describe('stacked statements', () => {
    it.each([
      'SELECT 1; SELECT 2',
      'SELECT 1; SELECT 2;',
      'SELECT 1;;',
      'SELECT * FROM t; DROP TABLE t',
      'SELECT 1 SELECT 2',
      'SELECT 1 WITH c AS (SELECT 1 AS a) SELECT * FROM c',
      "SELECT 1 /* c */ ; -- c\n SELECT 'x'",
    ])('%s', (query) => {
      expectRejected(query);
    });

    it('explains the trailing-semicolon rule', () => {
      const error = expectRejected('SELECT 1; SELECT 2', ErrorType.VALIDATION_ERROR);
      expect(error.message).toMatch(/only one statement/i);
      expect(error.message).toMatch(/trailing ";"/);
    });
  });

  describe('SELECT INTO', () => {
    it.each([
      'SELECT * INTO dbo.x FROM t',
      'SELECT * INTO x FROM t',
      'SELECT 1 AS a INTO #tmp',
      'SELECT a INTO @v FROM t',
      'WITH c AS (SELECT 1 AS a) SELECT * INTO x FROM c',
      'WITH c AS (SELECT 1 AS a) SELECT * INTO dbo.x FROM c',
      'SELECT * FROM (SELECT 1 AS a) d INTO x',
    ])('%s', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });
  });

  describe('procedure execution', () => {
    it.each([
      "exec('DELETE FROM t')",
      "SELECT 1 exec('DELETE FROM t')",
      'SELECT 1 exec  sp_who',
      'SELECT 1 exec [x]',
      'SELECT 1 EXEC dbo.p',
      'SELECT 1 EXECUTE dbo.p',
      "SELECT 1 EXECUTE('SELECT 1')",
      'SELECT 1 EXEC\tsp_who',
      'SELECT 1 EXEC\nsp_who',
      'SELECT 1 {call sp_who}',
    ])('%s', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });

    it('rejects a query that does not start with SELECT or WITH', () => {
      const error = expectRejected('sp_who', ErrorType.VALIDATION_ERROR);
      expect(error.message).toMatch(/must start with SELECT/);
    });
  });

  describe('external data sources', () => {
    it.each([
      "SELECT * FROM OPENQUERY(L, 'SELECT 1')",
      "SELECT * FROM OPENROWSET(BULK 'C:\\x.txt', SINGLE_CLOB) AS x",
      "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;Trusted_Connection=yes;', 'SELECT 1') AS x",
      "SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Data Source=x').db.dbo.t",
      'SELECT * FROM OPENXML(@h, \'/a\')',
    ])('%s', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });
  });

  describe('WAITFOR', () => {
    it.each(["SELECT 1 WAITFOR DELAY '00:00:10'", "SELECT 1 WAITFOR TIME '23:00'", "WAITFOR DELAY '00:00:01'"])(
      '%s',
      (query) => {
        expectRejected(query, ErrorType.VALIDATION_ERROR);
      },
    );
  });

  describe('comment tricks', () => {
    it.each([
      'SELECT 1 /* ; */ ; DELETE FROM t',
      'SELECT 1 /* ; */ ; SELECT 2',
      'SELECT 1 /* /* */ ; */ DELETE FROM t',
      'SELECT 1 /* /* */ ; */ ; SELECT 2',
      'SELECT 1 /* /* */ ; SELECT 2',
      'SELECT 1 /* /* */ DELETE FROM t --*/',
      "SELECT 1 /* -- */ , 'x\n*/ ; DELETE FROM t --'",
      "SELECT 1 -- /*\n, 'x */ ; DELETE FROM t --'",
      "SELECT 1 --\r'\nDELETE FROM t --'",
      "SELECT 1 --\u2028'\nDELETE FROM t --'",
    ])('%j', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });
  });

  describe('GO', () => {
    it.each(['SELECT 1\nGO', 'SELECT 1\nGO\nSELECT 2', 'SELECT 1\ngo\n', 'SELECT 1 GO 5'])('%j', (query) => {
      const error = expectRejected(query, ErrorType.VALIDATION_ERROR);
      expect(error.message).toMatch(/batch separator/);
    });
  });

  describe('CTE followed by a data change', () => {
    it.each([
      'WITH c AS (SELECT id FROM t) DELETE FROM c',
      'WITH c AS (SELECT id, x FROM t) UPDATE c SET x = 1',
      'WITH c AS (SELECT 1 AS a) INSERT INTO t SELECT a FROM c',
      'WITH c AS (SELECT 1 AS a) MERGE t USING c ON 1 = 1 WHEN MATCHED THEN DELETE;',
    ])('%s', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });
  });

  describe('sequences', () => {
    it.each(['SELECT NEXT VALUE FOR dbo.seq', 'SELECT next  value\nfor dbo.seq', 'SELECT NEXT /* x */ VALUE FOR dbo.seq'])(
      '%j',
      (query) => {
        const error = expectRejected(query, ErrorType.VALIDATION_ERROR);
        expect(error.message).toMatch(/NEXT VALUE FOR/);
      },
    );
  });

  describe('unterminated tokens', () => {
    it.each([
      ["SELECT 'abc", /string literal/],
      ["SELECT N'abc", /string literal/],
      ["SELECT 'it''s", /string literal/],
      ["SELECT 'a\\''", /string literal/],
      ['SELECT 1 /* abc', /never closed/],
      ['SELECT 1 /* /* */', /never closed/],
      ['SELECT [abc FROM t', /identifier/],
      ['SELECT [a]]b FROM t', /identifier/],
      ['SELECT "abc FROM t', /identifier/],
    ] as const)('%j', (query, message) => {
      const error = expectRejected(query, ErrorType.VALIDATION_ERROR);
      expect(error.message).toMatch(message);
    });
  });

  describe('denied keywords', () => {
    it.each([
      'SELECT 1 INSERT INTO t VALUES (1)',
      'SELECT 1 UPDATE t SET a = 1',
      'SELECT 1 DELETE t',
      'SELECT 1 TRUNCATE TABLE t',
      'SELECT 1 DROP TABLE t',
      'SELECT 1 ALTER TABLE t ADD c int',
      'SELECT 1 CREATE TABLE x (a int)',
      'SELECT 1 GRANT SELECT ON t TO u',
      'SELECT 1 REVOKE SELECT ON t TO u',
      'SELECT 1 DENY SELECT ON t TO u',
      "SELECT 1 BACKUP DATABASE x TO DISK = 'c:\\x.bak'",
      "SELECT 1 RESTORE DATABASE x FROM DISK = 'c:\\x.bak'",
      'SELECT 1 DBCC CHECKDB',
      'SELECT 1 RECONFIGURE',
      'SELECT 1 SHUTDOWN',
      'SELECT 1 KILL 55',
      'SELECT 1 USE master',
      'SELECT 1 SET NOCOUNT ON',
      'SELECT 1 DECLARE @x int',
      'SELECT 1 BEGIN TRAN',
      'SELECT 1 COMMIT',
      'SELECT 1 ROLLBACK',
      'SELECT 1 SAVE TRAN s',
      'SELECT 1 RECEIVE * FROM q',
      'SELECT 1 SEND ON CONVERSATION @h',
      'SELECT 1 WRITETEXT t.c @p 0x00',
      'SELECT 1 UPDATETEXT t.c @p 0 0 0x00',
      'SELECT 1 CHECKPOINT',
      'SELECT 1 ENABLE TRIGGER tr ON t',
      'SELECT 1 END CONVERSATION @h',
      "SELECT 1 OPEN SYMMETRIC KEY k DECRYPTION BY PASSWORD = 'x'",
      'SELECT * FROM t WITH (XLOCK)',
      'SELECT * FROM t WITH (UPDLOCK)',
      'SELECT * FROM t WITH (TABLOCKX)',
      'SELECT * FROM t FOR UPDATE',
      "SELECT 1 RAISERROR('x', 16, 1) WITH LOG",
      'SELECT 1 IF 1 = 1 SELECT 2',
      'select 1 dElEtE from t',
      'SELECT 1\u00a0DELETE FROM t',
      'SELECT 1DELETE FROM t',
      'SELECT $DELETE FROM t',
      'SELECT 1 ＤＥＬＥＴＥ FROM t',
    ])('%j', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });

    it('tells the caller to bracket an identifier that collides with a keyword', () => {
      const error = expectRejected('SELECT delete FROM t', ErrorType.VALIDATION_ERROR);
      expect(error.message).toContain('[delete]');
      expect(error.details).toMatchObject({ reason: 'denied_keyword', keyword: 'DELETE' });
    });
  });

  describe('non-SELECT statements', () => {
    it.each(['DELETE FROM t', 'UPDATE t SET a = 1', "INSERT INTO t VALUES (1)", 'TRUNCATE TABLE t', "EXEC sp_who", 'VALUES (1)'])(
      '%s',
      (query) => {
        expectRejected(query, ErrorType.VALIDATION_ERROR);
      },
    );

    it.each(['', '   ', '-- only a comment', '/* only a comment */'])('empty query %j', (query) => {
      const error = expectRejected(query, ErrorType.VALIDATION_ERROR);
      expect(error.message).toMatch(/empty/);
    });
  });

  describe('database references', () => {
    it.each([
      'SELECT * FROM HR.dbo.Salaries',
      'SELECT * FROM [HR].[dbo].[Salaries]',
      'SELECT * FROM "HR"."dbo"."Salaries"',
      'SELECT * FROM HR..Salaries',
      'SELECT * FROM [HR]..[Salaries]',
      'SELECT * FROM sales.dbo.t JOIN HR.dbo.Salaries s ON 1 = 1',
      'SELECT * FROM sales.dbo.t WHERE id IN (SELECT id FROM HR.dbo.Salaries)',
      'SELECT * FROM (SELECT * FROM HR.dbo.Salaries) d',
      'WITH c AS (SELECT * FROM HR.dbo.Salaries) SELECT * FROM c',
      'SELECT * FROM sales.dbo.t UNION SELECT * FROM HR.dbo.Salaries',
      'SELECT * FROM master.sys.databases',
      'SELECT * FROM [sales]].x].dbo.t',
    ])('%s (not whitelisted)', (query) => {
      const error = expectRejected(query, ErrorType.PERMISSION_ERROR, WHITELIST);
      expect(error.message).toMatch(/not in the list of databases/);
    });

    it.each([
      'SELECT * FROM srv.HR.dbo.Salaries',
      'SELECT * FROM [srv].[sales].[dbo].[t]',
      'SELECT * FROM srv.sales..t',
      'SELECT * FROM srv..dbo.t',
    ])('%s (4-part name)', (query) => {
      for (const options of [NO_WHITELIST, WHITELIST]) {
        const error = expectRejected(query, ErrorType.PERMISSION_ERROR, options);
        expect(error.message).toMatch(/linked server/);
      }
    });
  });
});

describe('validateReadOnlyQuery: accepts', () => {
  it.each([
    'SELECT 1',
    'select * from dbo.Customers',
    'SELECT a, b FROM t WHERE a > 1 AND b IS NOT NULL',
    'SELECT * FROM t1 INNER JOIN t2 ON t1.id = t2.id LEFT JOIN t3 ON t3.id = t1.id',
    'SELECT * FROM t1 FULL OUTER JOIN t2 ON t1.id = t2.id CROSS JOIN t3',
    'WITH c AS (SELECT id FROM t) SELECT * FROM c',
    'WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT * FROM b',
    'WITH r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 10) SELECT n FROM r',
    'SELECT a FROM t UNION SELECT a FROM u',
    'SELECT a FROM t UNION ALL SELECT a FROM u',
    'SELECT * FROM t WHERE id IN (SELECT id FROM u)',
    'SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.id = t.id)',
    'SELECT * FROM (SELECT a FROM t) AS d',
    'SELECT * FROM t CROSS APPLY (SELECT 1 AS z) x',
    '(SELECT 1)',
    'SELECT TOP 10 * FROM t',
    'SELECT TOP (10) * FROM t ORDER BY a DESC',
    'SELECT TOP 10 PERCENT * FROM t',
    'SELECT a FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
    'SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn FROM t',
    'SELECT SUM(x) OVER (ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM t',
    'SELECT a, COUNT(*) FROM t GROUP BY a HAVING COUNT(*) > 1',
    'SELECT a FROM t FOR JSON PATH',
    'SELECT a FROM t FOR XML PATH',
    "SELECT a FROM t FOR XML PATH('row')",
    'SELECT a FROM t FOR XML AUTO',
    "SELECT CASE WHEN a = 1 THEN 'x' WHEN a = 2 THEN 'y' ELSE 'z' END AS c FROM t",
    'SELECT CAST(a AS int), CONVERT(varchar(10), b, 120), IIF(a > 1, 1, 0) FROM t',
    'SELECT * FROM t WITH (NOLOCK)',
    'SELECT @@VERSION',
    'SELECT DISTINCT a FROM t',
    'SELECT * FROM (SELECT a, b FROM t) AS s PIVOT (MAX(b) FOR a IN ([1], [2])) p',
  ])('query shape: %s', (query) => {
    expectAccepted(query);
  });

  it.each([
    "SELECT N'héllo'",
    "SELECT n'x', N''",
    "SELECT 'it''s'",
    "SELECT * FROM t WHERE name = 'O''Brien'",
    "SELECT 'C:\\temp\\'",
    "SELECT 'a\\b', 'say \"hi\"'",
    "SELECT 'a\\'",
    "SELECT ''''",
    "SELECT 'line1\nline2'",
  ])('string literal: %j', (query) => {
    expectAccepted(query);
  });

  it.each([
    "SELECT 'please delete', 'DROP TABLE x; EXEC sp_who' FROM t",
    "SELECT * FROM t WHERE note LIKE '%; SELECT %'",
    'SELECT 1 -- drop table t',
    'SELECT 1 -- drop table t\n',
    '-- delete everything\nSELECT 1',
    'SELECT 1 /* exec sp_who; */',
    'SELECT 1 /* ; */',
    'SELECT 1 /* /* */ ; */',
    'SELECT /* outer /* inner */ still outer */ 1',
    "SELECT 1 -- don't\r\n",
    "SELECT 1 /* don't */",
  ])('denied words inside strings and comments: %j', (query) => {
    expectAccepted(query);
  });

  it.each([
    'SELECT [exec_date] FROM t',
    'SELECT t.[exec_date] FROM t',
    'SELECT [Order], [Delete], [Insert] FROM [Order]',
    'SELECT [a]]b] FROM t',
    'SELECT [a]]b] AS [x]]] FROM [t]]1]',
    'SELECT "exec" FROM "update"',
    'SELECT "a""b" FROM t',
    'SELECT [select;drop] FROM [go]',
    'SELECT [Open], [Close] FROM prices',
  ])('quoted identifiers: %s', (query) => {
    expectAccepted(query);
  });

  it.each([
    'SELECT crisp_products, exec_date, updated_at, deleted, inserted_by, into_col, created FROM t',
    'SELECT setting, user_settings, nextValue FROM t',
    'SELECT a AS executed FROM t',
    'SELECT DATEADD(day, -1, GETDATE()) AS yesterday',
  ])('identifiers containing denied words: %s', (query) => {
    expectAccepted(query);
  });

  it.each(['SELECT 1;', 'SELECT 1 ;  ', 'SELECT 1; -- done', 'SELECT 1; /* done */\n'])('trailing semicolon: %j', (query) => {
    expectAccepted(query);
  });

  it.each([
    'SELECT * FROM sales.dbo.t',
    'SELECT * FROM [sales].[dbo].[t]',
    'SELECT * FROM "reporting".dbo.t',
    'SELECT * FROM sales..t',
    'SELECT * FROM sales.dbo.t a JOIN reporting.dbo.u b ON a.id = b.id',
    'SELECT * FROM dbo.t',
    'SELECT * FROM t',
    'SELECT t.a FROM sales.dbo.t',
  ])('whitelisted database: %s', (query) => {
    expectAccepted(query, WHITELIST);
  });

  it.each(['SELECT * FROM SALES.dbo.t', 'SELECT * FROM [Sales].[dbo].[t]', 'SELECT * FROM "Reporting".dbo.t'])(
    'database spelled differently from the whitelist: %s',
    (query) => {
      const error = expectRejected(query, ErrorType.PERMISSION_ERROR, WHITELIST);
      expect(error.details?.reason).toBe('database_not_allowed');
    },
  );

  it('rejects a 4-part column name, which cannot be told apart from a linked-server name', () => {
    expectRejected('SELECT sales.dbo.t.a FROM sales.dbo.t', ErrorType.PERMISSION_ERROR, WHITELIST);
  });

  it.each(['SELECT * FROM HR.dbo.Salaries', 'SELECT * FROM HR..Salaries', 'SELECT * FROM [H.R].[dbo].[t]'])(
    'any database without a whitelist: %s',
    (query) => {
      expectAccepted(query, NO_WHITELIST);
    },
  );

  it.each([
    'SELECT * FROM INFORMATION_SCHEMA.TABLES',
    "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'x'",
    'SELECT * FROM sys.tables',
    'SELECT o.name, s.name FROM sys.objects o JOIN sys.schemas s ON o.schema_id = s.schema_id',
    'SELECT * FROM sales.INFORMATION_SCHEMA.TABLES',
    'SELECT * FROM sales.sys.tables',
  ])('catalog views: %s', (query) => {
    expectAccepted(query, WHITELIST);
  });
});
