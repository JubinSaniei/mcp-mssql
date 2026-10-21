import { describe, expect, it, vi } from 'vitest';
import sql from 'mssql';
import { ErrorType, MssqlMcpError } from '../errors.js';
import {
  SQL_PARAMETER_TYPES,
  buildAllowedProcedureSet,
  isProcedureAllowed,
  parseProcedureName,
  prepareProcedureParameter,
  requireProcedureName,
  resolveSqlType,
  wildcardEntries,
} from '../procedures.js';

function errorOf(fn: () => unknown): MssqlMcpError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MssqlMcpError);
    return error as MssqlMcpError;
  }
  throw new Error('expected an error');
}

describe('parseProcedureName', () => {
  it('accepts schema.proc and keeps the original case in the canonical name', () => {
    expect(parseProcedureName(' Sales.GetOrders ')).toEqual({
      ok: true,
      procedure: { schema: 'Sales', name: 'GetOrders', canonical: 'Sales.GetOrders', key: 'sales.getorders' },
    });
  });

  it('strips brackets', () => {
    const parsed = parseProcedureName('[dbo].[Get_Orders2]');
    expect(parsed.ok && parsed.procedure.canonical).toBe('dbo.Get_Orders2');
    const mixed = parseProcedureName('dbo.[p]');
    expect(mixed.ok && mixed.procedure.key).toBe('dbo.p');
  });

  it('reports unqualified names instead of assuming dbo', () => {
    expect(parseProcedureName('GetOrders')).toEqual({ ok: false, reason: 'unqualified' });
    expect(parseProcedureName('[GetOrders]')).toEqual({ ok: false, reason: 'unqualified' });
  });

  it('rejects names outside the allowed format', () => {
    for (const name of ['db.dbo.p', 'dbo.p;DROP', 'dbo.[my proc]', 'dbo.', '.p', '[dbo.p]', 'dbo.p]]']) {
      expect(parseProcedureName(name)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(parseProcedureName('  ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('buildAllowedProcedureSet', () => {
  it('normalises entries and reports unqualified and invalid ones', () => {
    const onIgnored = vi.fn();
    const allowed = buildAllowedProcedureSet(['dbo.GetX', '[Rpt].[Monthly]', 'Bare', 'a.b.c', ''], onIgnored);
    expect([...allowed]).toEqual(['dbo.getx', 'rpt.monthly']);
    expect(onIgnored).toHaveBeenCalledWith('Bare', 'unqualified');
    expect(onIgnored).toHaveBeenCalledWith('a.b.c', 'invalid');
    expect(onIgnored).toHaveBeenCalledTimes(2);
  });

  it('matches requested names case-insensitively, with or without brackets', () => {
    const allowed = buildAllowedProcedureSet(['dbo.GetX']);
    expect(isProcedureAllowed(allowed, requireProcedureName('[DBO].[getx]'))).toBe(true);
    expect(isProcedureAllowed(allowed, requireProcedureName('dbo.GetY'))).toBe(false);
  });

  it('accepts schema.* and [schema].* entries, which allow every procedure in that schema', () => {
    const onIgnored = vi.fn();
    const allowed = buildAllowedProcedureSet(['dbo.*', ' [Rpt].* '], onIgnored);
    expect([...allowed]).toEqual(['dbo.*', 'rpt.*']);
    expect(onIgnored).not.toHaveBeenCalled();
    expect(isProcedureAllowed(allowed, requireProcedureName('dbo.GL_DistUpdate_UpdateDistributions_SP'))).toBe(true);
    expect(isProcedureAllowed(allowed, requireProcedureName('[RPT].[Monthly]'))).toBe(true);
    expect(isProcedureAllowed(allowed, requireProcedureName('sales.GetOrders'))).toBe(false);
  });

  it('accepts a bare * entry, which allows every schema-qualified procedure', () => {
    const allowed = buildAllowedProcedureSet([' * ']);
    expect([...allowed]).toEqual(['*']);
    expect(isProcedureAllowed(allowed, requireProcedureName('dbo.GetX'))).toBe(true);
    expect(isProcedureAllowed(allowed, requireProcedureName('sales.GetOrders'))).toBe(true);
  });

  it('keeps sys and INFORMATION_SCHEMA procedures out of a bare *', () => {
    const allowed = buildAllowedProcedureSet(['*']);
    for (const name of ['sys.sp_executesql', '[SYS].[xp_cmdshell]', 'INFORMATION_SCHEMA.p']) {
      expect(isProcedureAllowed(allowed, requireProcedureName(name))).toBe(false);
    }
  });

  it('allows sys procedures only through an exact entry or an explicit sys.*', () => {
    const exact = buildAllowedProcedureSet(['*', 'sys.sp_who']);
    expect(isProcedureAllowed(exact, requireProcedureName('sys.sp_who'))).toBe(true);
    expect(isProcedureAllowed(exact, requireProcedureName('sys.sp_executesql'))).toBe(false);
    expect(isProcedureAllowed(buildAllowedProcedureSet(['sys.*']), requireProcedureName('sys.sp_executesql'))).toBe(true);
  });

  it('accepts whitespace around the dot of a schema.* entry', () => {
    expect([...buildAllowedProcedureSet(['dbo. *', 'rpt .*'])]).toEqual(['dbo.*', 'rpt.*']);
  });

  it('rejects other wildcard forms as invalid entries', () => {
    const onIgnored = vi.fn();
    const allowed = buildAllowedProcedureSet(['*.*', '*.p', 'dbo.[*]', 'dbo.Get*', '[*]', 'db.dbo.*', '**'], onIgnored);
    expect(allowed.size).toBe(0);
    expect(onIgnored).toHaveBeenCalledTimes(7);
    for (const call of onIgnored.mock.calls) expect(call[1]).toBe('invalid');
  });

  it('lists the wildcard entries of an allow-list', () => {
    expect(wildcardEntries(buildAllowedProcedureSet(['dbo.GetX']))).toEqual([]);
    expect(wildcardEntries(buildAllowedProcedureSet(['dbo.GetX', 'Rpt.*', '*']))).toEqual(['rpt.*', '*']);
  });
});

describe('requested procedure names', () => {
  it('cannot use wildcards', () => {
    for (const name of ['*', 'dbo.*', '[dbo].*']) {
      expect(errorOf(() => requireProcedureName(name)).errorType).toBe(ErrorType.VALIDATION_ERROR);
    }
  });
});

describe('requireProcedureName', () => {
  it('throws a validation error for unqualified names', () => {
    const error = errorOf(() => requireProcedureName('GetOrders'));
    expect(error.errorType).toBe(ErrorType.VALIDATION_ERROR);
    expect(error.message).toContain('must be schema-qualified');
    expect(error.message).toContain('dbo.GetOrders');
  });

  it('throws a validation error for invalid names', () => {
    expect(errorOf(() => requireProcedureName('x;y')).errorType).toBe(ErrorType.VALIDATION_ERROR);
  });
});

describe('resolveSqlType', () => {
  it('accepts every supported type name, case-insensitively', () => {
    for (const type of SQL_PARAMETER_TYPES) {
      expect(() => resolveSqlType('p', type.toUpperCase())).not.toThrow();
    }
  });

  it('maps simple types to their driver factories', () => {
    expect(resolveSqlType('p', 'Int')).toBe(sql.Int);
    expect(resolveSqlType('p', 'uniqueidentifier')).toBe(sql.UniqueIdentifier);
  });

  it('applies precision and scale to decimal', () => {
    const type = resolveSqlType('p', 'decimal', { precision: 18, scale: 2 }) as sql.ISqlTypeWithPrecisionScale;
    expect(type.type).toBe(sql.Decimal);
    expect(type.precision).toBe(18);
    expect(type.scale).toBe(2);
  });

  it('applies length, including max', () => {
    const fixed = resolveSqlType('p', 'nvarchar', { length: 50 }) as sql.ISqlTypeWithLength;
    expect(fixed.type).toBe(sql.NVarChar);
    expect(fixed.length).toBe(50);
    const max = resolveSqlType('p', 'varbinary', { length: 'max' }) as sql.ISqlTypeWithLength;
    expect(max.length).toBe(sql.MAX);
    const binary = resolveSqlType('p', 'binary', { length: 16 }) as sql.ISqlTypeWithLength;
    expect(binary.length).toBe(16);
  });

  it('applies scale to time types', () => {
    const type = resolveSqlType('p', 'datetime2', { scale: 3 }) as sql.ISqlTypeWithScale;
    expect(type.type).toBe(sql.DateTime2);
    expect(type.scale).toBe(3);
  });

  it('defaults the scale of time types to 7', () => {
    for (const [name, factory] of [['time', sql.Time], ['datetime2', sql.DateTime2], ['datetimeoffset', sql.DateTimeOffset]] as const) {
      const type = resolveSqlType('p', name) as sql.ISqlTypeWithScale;
      expect(type.type).toBe(factory);
      expect(type.scale).toBe(7);
    }
  });

  it('rejects unknown types instead of defaulting to nvarchar', () => {
    const error = errorOf(() => resolveSqlType('p', 'string'));
    expect(error.errorType).toBe(ErrorType.VALIDATION_ERROR);
    expect(error.message).toContain("unknown SQL type 'string'");
  });

  it('rejects options a type does not take, and out-of-range values', () => {
    expect(() => resolveSqlType('p', 'int', { length: 4 })).toThrow(MssqlMcpError);
    expect(() => resolveSqlType('p', 'nvarchar', { precision: 4 })).toThrow(MssqlMcpError);
    expect(() => resolveSqlType('p', 'char', { length: 'max' })).toThrow(MssqlMcpError);
    expect(() => resolveSqlType('p', 'nvarchar', { length: 4001 })).toThrow(MssqlMcpError);
    expect(() => resolveSqlType('p', 'decimal', { precision: 5, scale: 6 })).toThrow(MssqlMcpError);
    expect(() => resolveSqlType('p', 'time', { precision: 3 })).toThrow(MssqlMcpError);
    expect(() => resolveSqlType('p', 'time', { scale: 8 })).toThrow(MssqlMcpError);
  });
});

describe('prepareProcedureParameter', () => {
  it('strips a leading @ and defaults direction to in', () => {
    const prepared = prepareProcedureParameter({ name: '@Id', type: 'int', value: 5 });
    expect(prepared).toEqual({ name: 'Id', direction: 'in', sqlType: sql.Int, value: 5 });
  });

  it('keeps output direction', () => {
    expect(prepareProcedureParameter({ name: 'Total', type: 'money', direction: 'out' }).direction).toBe('out');
  });

  it('requires a name and a type', () => {
    expect(() => prepareProcedureParameter({ name: '@', type: 'int' })).toThrow(MssqlMcpError);
    expect(() => prepareProcedureParameter({ name: 'x', type: '' })).toThrow(MssqlMcpError);
  });
});
