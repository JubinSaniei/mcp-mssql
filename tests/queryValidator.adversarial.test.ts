import { describe, expect, it } from 'vitest';
import { validateReadOnlyQuery, type ReadOnlyQueryOptions } from '../queryValidator.js';
import { ErrorType, MssqlMcpError } from '../errors.js';

const NO_WHITELIST: ReadOnlyQueryOptions = { allowedDatabases: [] };
const WHITELIST: ReadOnlyQueryOptions = { allowedDatabases: ['sales', 'reporting'] };

function rejectionOf(query: string, options: ReadOnlyQueryOptions): MssqlMcpError {
  try {
    validateReadOnlyQuery(query, options);
  } catch (error) {
    expect(error).toBeInstanceOf(MssqlMcpError);
    return error as MssqlMcpError;
  }
  throw new Error(`Expected the query to be rejected: ${JSON.stringify(query)}`);
}

function expectRejected(query: string, errorType?: ErrorType, options: ReadOnlyQueryOptions = NO_WHITELIST): MssqlMcpError {
  const error = rejectionOf(query, options);
  if (errorType !== undefined) expect(error.errorType).toBe(errorType);
  return error;
}

function expectAccepted(query: string, options: ReadOnlyQueryOptions = NO_WHITELIST): void {
  expect(() => validateReadOnlyQuery(query, options)).not.toThrow();
}

const VERBS = ['delete', 'drop', 'exec', 'insert', 'update', 'merge'];
const OPEN_EXPONENTS = ['1e', '1E', '1.e', '1e+', '1e-', '.5e'];

describe('adversarial: rejects', () => {
  describe('keyword glued to a float literal with an open exponent (SQL Server ends the literal after "e")', () => {
    it.each(['SELECT 1edelete FROM t', 'SELECT 1Edrop FROM t', 'SELECT 1.edelete FROM t', 'SELECT 1e+delete FROM t'])('%s', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });

    it.each(OPEN_EXPONENTS.flatMap((literal) => VERBS.map((verb) => `SELECT ${literal}${verb} FROM t`)))('%s', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });

    it('names the glued literal', () => {
      const error = expectRejected('SELECT 1edelete FROM t', ErrorType.VALIDATION_ERROR);
      expect(error.details?.reason).toBe('glued_literal');
      expect(error.message).toContain('"1e"');
    });
  });

  describe('word glued to any numeric, money or hex literal', () => {
    it.each([
      'SELECT 1e5delete FROM t',
      'SELECT 1delete FROM t',
      'SELECT $1edelete FROM t',
      'SELECT $1.delete FROM t',
      'SELECT 0xdelete FROM t',
      'SELECT 0x1Fexec FROM t',
      'SELECT 1_x FROM t',
      'SELECT 1@x FROM t',
      'SELECT 1#x FROM t',
      'SELECT 1$x FROM t',
    ])('%s', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });
  });

  describe('control and invisible characters that SQL Server treats as separators', () => {
    it.each([
      'SELECT NEXT\u0001VALUE\u0001FOR s',
      'SELECT NEXT\u0085VALUE\u0085FOR s',
      'SELECT NEXT​VALUE​FOR s',
      'SELECT 1\u0000',
      'SELECT 1\u001f',
      'SELECT﻿1',
      'SELECT * FROM srv\u0001.db.dbo.t',
    ])('%j', (query) => {
      const error = expectRejected(query, ErrorType.VALIDATION_ERROR);
      expect(error.details?.reason).toBe('unsupported_character');
    });
  });

  describe('functions that read server files, logs, traces or audits', () => {
    it.each(
      [
        'fn_dblog',
        'fn_dblog_xtp',
        'fn_dbslog',
        'fn_dump_dblog',
        'fn_dump_dblog_xtp',
        'fn_filelog',
        'fn_full_dblog',
        'fn_get_audit_file',
        'fn_get_audit_file_v2',
        'fn_trace_gettable',
        'fn_xe_file_target_read_file',
        'fn_xe_telemetry_blob_target_read_file',
        'fn_MSxe_read_event_stream',
        'dm_os_enumerate_filesystem',
        'dm_os_file_exists',
      ].map((name) => `SELECT * FROM sys.${name}(NULL)`),
    )('%s', (query) => {
      expectRejected(query, ErrorType.VALIDATION_ERROR);
    });

    it.each([
      'SELECT * FROM fn_dblog(NULL, NULL)',
      'SELECT * FROM ::fn_dblog(NULL, NULL)',
      'SELECT * FROM master.sys.fn_dblog(NULL, NULL)',
      'SELECT * FROM sys.FN_DBLOG(NULL, NULL)',
      'SELECT * FROM sys.[fn_dblog](NULL, NULL)',
      'SELECT * FROM sys.[fn_dblog ](NULL, NULL)',
      'SELECT * FROM sys."fn_dblog"(NULL, NULL)',
      'SELECT * FROM sys.ｆｎ_dblog(NULL, NULL)',
      'SELECT * FROM sys.fn＿dblog(NULL, NULL)',
      'SELECT * FROM sys.fn_dblóg(NULL, NULL)',
    ])('%s', (query) => {
      const error = expectRejected(query, ErrorType.VALIDATION_ERROR);
      expect(error.details?.reason).toBe('denied_object');
    });
  });

  describe('names with 4 or more parts', () => {
    it.each([
      'SELECT * FROM srv.db.dbo.t',
      'SELECT * FROM [srv].[db].[dbo].[t]',
      'SELECT * FROM srv . db . dbo . t',
      'SELECT * FROM srv . db.dbo.t',
      'SELECT * FROM srv/**/./**/db.dbo.t',
      'SELECT * FROM srv...t',
      'SELECT * FROM srv.db..t',
      'SELECT * FROM (SELECT * FROM srv.db.dbo.t) x',
      'SELECT * FROM a JOIN srv.db.dbo.t ON 1 = 1',
      'SELECT * FROM a CROSS APPLY (SELECT * FROM srv.db.dbo.t) x',
      'SELECT * FROM a OUTER APPLY (SELECT TOP 1 * FROM srv.db.dbo.t) x',
      'WITH c AS (SELECT * FROM srv.db.dbo.t) SELECT * FROM c',
      'SELECT * FROM a WHERE EXISTS (SELECT 1 FROM srv.db.dbo.t)',
      'SELECT (SELECT TOP 1 id FROM srv.db.dbo.t) AS x',
      'SELECT * FROM a UNION ALL SELECT * FROM srv.db.dbo.t',
      "SELECT * FROM CONTAINSTABLE(srv.db.dbo.t, c, 'x') AS k",
      'SELECT a.b.c.d FROM t',
    ])('%s', (query) => {
      expectRejected(query, ErrorType.PERMISSION_ERROR);
    });
  });

  describe('databases outside the whitelist in nested queries and table-argument functions', () => {
    it.each([
      "SELECT * FROM CONTAINSTABLE(other.dbo.t, c, 'x') AS k",
      "SELECT * FROM FREETEXTTABLE(other.dbo.t, c, 'x') AS k",
      'SELECT * FROM SEMANTICKEYPHRASETABLE(other.dbo.t, c) AS k',
      'SELECT * FROM SEMANTICSIMILARITYTABLE(other.dbo.t, c, 1) AS k',
      'SELECT * FROM (SELECT * FROM other..t) x',
      'SELECT * FROM t WHERE EXISTS (SELECT 1 FROM other..t)',
      'SELECT * FROM t WHERE id IN (SELECT id FROM other.dbo.t)',
      'SELECT * FROM t CROSS APPLY (SELECT * FROM other.dbo.u) x',
      'SELECT * FROM t OUTER APPLY (SELECT TOP 1 * FROM other..u) x',
      'SELECT * FROM t LEFT JOIN (SELECT * FROM other..u) x ON 1 = 1',
      'WITH c AS (SELECT * FROM sales.dbo.t), d AS (SELECT * FROM other..t) SELECT * FROM c, d',
      'SELECT * FROM other . . t',
      'SELECT * FROM other/**/./**/./**/t',
      'SELECT * FROM other .dbo.t',
    ])('%s', (query) => {
      expectRejected(query, ErrorType.PERMISSION_ERROR, WHITELIST);
    });
  });

  describe('lexing details that already matched SQL Server', () => {
    it.each([
      'SELECT NEXT /* c */ VALUE -- c\n FOR s',
      'SELECT NEXT\r\nVALUE\tFOR s',
      'SELECT NEXT VALUE　FOR s',
      'SELECT 1 AS a delete FROM t',
      'SELECT 1 AS a delete FROM t',
      'SELECT 1 AS a\u000bdelete FROM t',
      'SELECT 1 GO',
      'SELECT 1\nGO',
      'SELECT 1\ngo 2',
      "SELECT 'a'delete FROM t",
      "SELECT N'a'exec x",
      'SELECT [a]delete FROM t',
      'SELECT "a"delete FROM t',
      'SELECT 1 {call p}',
      "SELECT {fn x()} exec('x')",
    ])('%j', (query) => {
      expectRejected(query);
    });
  });
});

describe('adversarial: accepts', () => {
  it.each([
    'SELECT 1e5 AS a, 1.5E-3 AS b, 2E+10 AS c',
    'SELECT 1e AS a, 1.e AS b, 1e+ AS c, .5e AS d',
    'SELECT 1. AS a, .5 AS b',
    'SELECT $1.50 AS a, $1 AS b, $.5 AS c',
    'SELECT 0x1F AS a, 0x AS b',
    'SELECT 1e +2 AS a',
    'WITH c AS (SELECT 1 AS a), d AS (SELECT a FROM c) SELECT * FROM d',
    'SELECT a, ROW_NUMBER() OVER (PARTITION BY b ORDER BY c) AS rn FROM t',
    'SELECT a FROM t FOR JSON PATH',
    'SELECT a FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
    'SELECT name FROM sys.tables',
    'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES',
    'SELECT [delete], [insert] AS [drop table] FROM [exec]',
    'SELECT "update" FROM t',
    'SELECT [a;delete] FROM t',
    'SELECT "a;delete" FROM t',
    'SELECT a COLLATE Latin1_General_CI_AS AS a FROM t',
    'SELECT $IDENTITY FROM t',
    "SELECT 'fn_dblog' AS s, fn_dblog_count FROM t",
    "SELECT 'a\u0000b' AS s",
    'SELECT [a\u0001b] FROM t',
    'SELECT 1 -- \u0001 note\n',
    'SELECT a　FROM t',
    'SELECT\u000ba\u000cFROM t',
    'SELECT t.a FROM db.dbo.t',
    "SELECT * FROM CONTAINSTABLE(t, c, 'x') AS k",
  ])('%j', (query) => {
    expectAccepted(query);
  });

  it.each([
    'SELECT * FROM sales..t',
    'SELECT * FROM sales . . t',
    'SELECT * FROM (SELECT * FROM reporting.dbo.t) x',
    "SELECT * FROM CONTAINSTABLE(sales.dbo.t, c, 'x') AS k",
    "SELECT * FROM CONTAINSTABLE(dbo.t, c, 'x') AS k",
  ])('whitelisted: %s', (query) => {
    expectAccepted(query, WHITELIST);
  });
});

describe('adversarial: known false positives (valid read-only T-SQL that is rejected)', () => {
  it.each([
    // A literal glued to a word: SQL Server splits it, but the validator rejects it.
    'SELECT 1AS a',
    'SELECT a FROM t ORDER BY 1DESC',
    // 4-part column names (deprecated) look the same as linked-server names.
    'SELECT sales.dbo.t.a FROM sales.dbo.t',
    // A column or alias named like a denied function, even when bracketed.
    'SELECT [fn_dblog] FROM t',
    // Syntax node-sql-parser does not read.
    "SELECT 1 AS a WHERE {d '2020-01-01'} > '2019-01-01'",
    'SELECT $ AS a',
    'SELECT a FROM t FOR JSON AUTO, INCLUDE_NULL_VALUES',
  ])('%s', (query) => {
    expectRejected(query);
  });
});
