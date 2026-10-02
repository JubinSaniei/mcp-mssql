import { describe, expect, it } from 'vitest';
import { validateReadOnlyQuery } from '../queryValidator.js';

const NO_WHITELIST = { allowedDatabases: [] as readonly string[] };
const ONE_DATABASE = { allowedDatabases: ['mydb'] as readonly string[] };

// Builds a one-character string from a code point, so invisible or look-alike characters stay readable in source.
const cp = (codePoint: number): string => String.fromCodePoint(codePoint);

function reasonFor(query: string, options = NO_WHITELIST): string {
  try {
    validateReadOnlyQuery(query, options);
  } catch (error: unknown) {
    return String((error as { details?: { reason?: unknown } }).details?.reason);
  }
  return 'allowed';
}

describe('literals glued to a following token', () => {
  // SQL Server ends a numeric literal at the first character that cannot extend it, so a
  // word glued to one starts a new token and can begin a second statement.
  it.each([
    'SELECT 1edelete FROM t',
    'SELECT 1Edrop FROM t',
    'SELECT 1e+delete FROM t',
    'SELECT 1.edelete FROM t',
    'SELECT 0xdelete FROM t',
    'SELECT 0xzz FROM t',
    'SELECT $1delete FROM t',
    `SELECT 1${cp(0x00e9)}delete FROM t`,
    `SELECT 1${cp(0xff45)}delete FROM t`,
    `SELECT 1${cp(0x09e7)} FROM t`,
    `SELECT 1${cp(0x0660)} FROM t`,
    'SELECT 1_x FROM t',
  ])('rejects %j', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).toThrow();
  });

  it('names the glued literal as the reason', () => {
    expect(reasonFor('SELECT 1edelete FROM t')).toBe('glued_literal');
  });
});

describe('characters SQL Server reads as separators', () => {
  it.each([
    ['NUL', 'SELECT 1\u0000FROM t'],
    ['SO', 'SELECT 1\u000eFROM t'],
    ['NEL', 'SELECT 1\u0085FROM t'],
    ['ZWSP', `SELECT 1${cp(0x200b)}FROM t`],
    ['BOM', `SELECT 1${cp(0xfeff)}FROM t`],
  ])('rejects %s', (_name, query) => {
    expect(reasonFor(query)).toBe('unsupported_character');
  });
});

describe('a second statement glued to the first', () => {
  it.each([
    'SELECT 1 SELECT 2',
    'SELECT 1e SELECT 2',
    'SELECT [a]SELECT * FROM other.dbo.t',
    'SELECT 1 FROM t SELECT 2',
    'SELECT 1 DELETE t',
    `SELECT 1 DELE${cp(0x200c)}TE t`,
  ])('rejects %j', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).toThrow();
  });
});

describe('name chains', () => {
  it.each([
    'SELECT * FROM srv.other.dbo.t',
    'SELECT * FROM t a CROSS APPLY srv.db.dbo.f(a.x) y',
    'SELECT * FROM t JOIN srv.db.dbo.u u ON 1=1',
    'WITH c AS (SELECT * FROM srv.db.dbo.t) SELECT * FROM c',
  ])('rejects the 4-part name in %j', (query) => {
    expect(reasonFor(query, ONE_DATABASE)).toBe('linked_server');
  });

  it.each([
    'SELECT * FROM other.dbo.t',
    'SELECT * FROM other . dbo . t',
    'SELECT * FROM other/**/.dbo.t',
    'SELECT * FROM other..t',
    'SELECT * FROM other. .t',
    'SELECT * FROM [other].[dbo].[t]',
    'SELECT * FROM [other[db].dbo.t',
    'WITH c AS (SELECT * FROM other.dbo.t) SELECT * FROM c',
    'SELECT (SELECT TOP 1 x FROM other.dbo.t) AS v',
    'SELECT * FROM a JOIN other.dbo.t ON 1=1',
  ])('keeps %j outside the whitelist', (query) => {
    expect(reasonFor(query, ONE_DATABASE)).toBe('database_not_allowed');
  });

  it.each(['SELECT * FROM mydb.dbo.t', 'SELECT * FROM [mydb].dbo.t'])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, ONE_DATABASE)).not.toThrow();
  });

  it('keeps a differently-cased database name outside the whitelist', () => {
    expect(reasonFor('SELECT * FROM MyDb.dbo.t', ONE_DATABASE)).toBe('database_not_allowed');
  });
});

describe('sequences and external reads', () => {
  it.each([
    'SELECT NEXT VALUE FOR dbo.s',
    'SELECT next value for dbo.s',
    'SELECT NEXT/**/VALUE/**/FOR dbo.s',
    'SELECT NEXT\tVALUE\nFOR dbo.s',
    'SELECT NEXT VALUE FOR [s]',
    'SELECT NEXT VALUE FOR mydb.dbo.s',
  ])('rejects %j', (query) => {
    expect(reasonFor(query, ONE_DATABASE)).toBe('denied_keyword');
  });

  it.each([
    'SELECT * FROM sys.fn_dblog(NULL,NULL)',
    'SELECT * FROM master.sys.fn_dblog(NULL,NULL)',
    'SELECT * FROM [master].[sys].[fn_dblog](NULL,NULL)',
    `SELECT * FROM sys.fn_db${cp(0x013a)}og(NULL,NULL)`,
  ])('rejects the file-reading function in %j', (query) => {
    expect(reasonFor(query, ONE_DATABASE)).toBe('denied_object');
  });

  it('still allows a bracketed column named NEXT', () => {
    expect(() => validateReadOnlyQuery('SELECT [NEXT] FROM t', NO_WHITELIST)).not.toThrow();
  });
});

describe('common read-only queries still pass', () => {
  it.each([
    'SELECT TOP 10 * FROM dbo.Orders ORDER BY OrderDate DESC',
    'SELECT o.Id, c.Name FROM dbo.Orders o JOIN dbo.Customers c ON c.Id = o.CustomerId',
    'SELECT CustomerId, COUNT(*) AS n FROM dbo.Orders GROUP BY CustomerId HAVING COUNT(*) > 1',
    'SELECT * FROM dbo.Orders ORDER BY Id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY',
    'WITH x AS (SELECT Id, ROW_NUMBER() OVER (ORDER BY OrderDate) AS rn FROM dbo.Orders) SELECT * FROM x WHERE rn = 1',
    'SELECT Id FROM dbo.A UNION ALL SELECT Id FROM dbo.B',
    "SELECT * FROM dbo.T WITH (NOLOCK) WHERE name LIKE N'%abc%'",
    'SELECT * FROM dbo.T CROSS APPLY OPENJSON(T.js) j',
    'SELECT a.Id, x.v FROM dbo.A a OUTER APPLY (SELECT TOP 1 v FROM dbo.B b WHERE b.aid = a.Id) x',
    'SELECT * FROM (SELECT cat, amt FROM dbo.S) s PIVOT (SUM(amt) FOR cat IN ([A],[B])) p',
    'SELECT id, name FROM dbo.T FOR JSON PATH',
    'SELECT 1.5, .5, 1e3, 0x1F, $10.00',
    'SELECT [Close], [Open] FROM dbo.Prices',
    'SELECT * FROM dbo.T WHERE x = 1;',
  ])('allows %j', (query) => {
    expect(() => validateReadOnlyQuery(query, NO_WHITELIST)).not.toThrow();
  });
});
