import nodeSqlParser from 'node-sql-parser';
import { MssqlMcpError, ErrorType } from './errors.js';

export interface ReadOnlyQueryOptions {
  /**
   * Allowed database names as spelled in the allow-list, trimmed and without delimiters.
   * Database names in the query must match one of them exactly. An empty array means no
   * whitelist.
   */
  allowedDatabases: readonly string[];
}

const parser = new nodeSqlParser.Parser();
const PARSER_OPTIONS = { database: 'transactsql' };

/**
 * Stands in for "]" inside bracketed identifiers in the text handed to node-sql-parser,
 * which cannot read the "]]" escape. It is mapped back when database names are checked.
 * U+E000 is a private-use character.
 */
const BRACKET_ESCAPE_PLACEHOLDER = String.fromCharCode(0xe000);

function deny(reason: string, ...keywords: string[]): Array<[string, string]> {
  return keywords.map((keyword) => [keyword, reason]);
}

/**
 * Words that may not appear outside strings, comments and quoted identifiers, mapped to
 * the reason given to the caller. Besides statements that change data, schema,
 * permissions, server or session state, run code or read external data, the list holds
 * every other statement keyword that has no use inside a SELECT, so such a statement
 * cannot start without a ";". The statement starts that a SELECT does use (SELECT, WITH,
 * FETCH and "(") are checked by position in checkStatementBoundaries.
 */
const DENIED_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ...deny('it modifies data', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'WRITETEXT', 'UPDATETEXT'),
  ...deny('it changes the database schema', 'DROP', 'ALTER', 'CREATE', 'ADD', 'TRIGGER'),
  ...deny('enabling or disabling triggers changes the database', 'ENABLE', 'DISABLE'),
  ...deny('it changes permissions or the security context', 'GRANT', 'REVOKE', 'DENY', 'SETUSER', 'REVERT'),
  ...deny('executing procedures or dynamic SQL is not permitted', 'EXEC', 'EXECUTE', 'CALL'),
  ...deny('SELECT ... INTO creates a table; remove the INTO clause to return the rows directly', 'INTO'),
  ...deny(
    'it is a server administration command',
    'BACKUP',
    'RESTORE',
    'DUMP',
    'LOAD',
    'DBCC',
    'RECONFIGURE',
    'SHUTDOWN',
    'KILL',
    'CHECKPOINT',
  ),
  ...deny('it suspends the session', 'WAITFOR'),
  ...deny(
    'reading from linked servers, files or external data sources is not permitted',
    'OPENROWSET',
    'OPENQUERY',
    'OPENDATASOURCE',
    'OPENXML',
    'BULK',
  ),
  ...deny('changing session state or declaring variables is not permitted', 'USE', 'SET', 'DECLARE'),
  ...deny('transaction control is not permitted', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE'),
  ...deny('Service Broker commands change queues and conversations', 'RECEIVE', 'SEND', 'CONVERSATION'),
  ...deny('opening or closing cursors and encryption keys is not permitted', 'OPEN', 'CLOSE', 'DEALLOCATE'),
  ...deny('exclusive and update lock hints block other sessions', 'XLOCK', 'UPDLOCK', 'TABLOCKX'),
  ...deny(
    'only a single SELECT statement is allowed, without control-flow or other statements',
    'IF',
    'WHILE',
    'GOTO',
    'RETURN',
    'BREAK',
    'CONTINUE',
    'PRINT',
    'RAISERROR',
    'THROW',
    'READTEXT',
    'LINENO',
  ),
]);

/**
 * Reserved words after which a parenthesised SELECT is a subquery. After any other token,
 * such as a name, a literal or ")", SQL Server ends the statement and reads "(SELECT ...)"
 * as a new one.
 */
const SUBQUERY_AFTER_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'DISTINCT',
  'ALL',
  'TOP',
  'FROM',
  'JOIN',
  'WHERE',
  'ON',
  'HAVING',
  'BY',
  'AS',
  'IN',
  'EXISTS',
  'ANY',
  'SOME',
  'AND',
  'OR',
  'NOT',
  'LIKE',
  'BETWEEN',
  'ESCAPE',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'UNION',
  'EXCEPT',
  'INTERSECT',
]);

/** Operators and punctuation after which a parenthesised SELECT is a subquery. "*" is checked separately. */
const SUBQUERY_AFTER_SYMBOLS: ReadonlySet<string> = new Set([',', '=', '<', '>', '+', '-', '/', '%', '&', '|', '^', '~', '!']);

/**
 * Keywords that form a whole expression without parentheses. SQL Server ends the
 * statement after "SELECT NULL" or "SELECT CURRENT_USER" and reads a following
 * "((SELECT ...))" as a new statement, rather than as a function call.
 */
const NOT_CALLABLE_WORDS: ReadonlySet<string> = new Set([
  'NULL',
  'DEFAULT',
  'END',
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_USER',
  'SESSION_USER',
  'SYSTEM_USER',
  'USER',
  'IDENTITYCOL',
  'ROWGUIDCOL',
]);

/**
 * System functions and views that read server files, transaction logs, backups, traces,
 * audits or Extended Events data, or probe the server's file system. They are matched
 * against plain words and against the content of quoted identifiers ([fn_dblog],
 * "fn_dblog"), because SQL Server resolves all of these forms to the same object.
 */
const DENIED_OBJECTS: ReadonlySet<string> = new Set(
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
  ].map((name) => name.toUpperCase()),
);

/**
 * Full-text and semantic rowset functions whose first argument is a table name. The
 * parser reads that argument as a column reference, so it is checked separately.
 */
const TABLE_ARGUMENT_FUNCTIONS: ReadonlySet<string> = new Set([
  'CONTAINSTABLE',
  'FREETEXTTABLE',
  'SEMANTICKEYPHRASETABLE',
  'SEMANTICSIMILARITYTABLE',
  'SEMANTICSIMILARITYDETAILSTABLE',
]);

/** System CLR types whose static methods may be called as "type::Method(...)". */
const STATIC_METHOD_TYPES: ReadonlySet<string> = new Set(['GEOGRAPHY', 'GEOMETRY', 'HIERARCHYID']);

/**
 * System types that node-sql-parser does not accept as the target type of CAST. In the
 * parser text they are written as INT; the type names no table, column or function.
 */
const CAST_TYPES_PARSER_LACKS: ReadonlySet<string> = new Set(['XML', 'SQL_VARIANT', 'GEOGRAPHY', 'GEOMETRY', 'HIERARCHYID']);

/**
 * Folds a name the way a case-, accent- and width-insensitive collation compares it:
 * compatibility forms (e.g. full-width letters) are normalised, combining marks are
 * dropped, surrounding whitespace is trimmed and the result is upper-cased.
 */
function foldName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC').trim().toUpperCase();
}

type TokenKind = 'word' | 'quotedIdentifier' | 'string' | 'number' | 'semicolon' | 'dot' | 'symbol';

interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** Unescaped content, for strings and quoted identifiers. */
  value?: string;
  /** True for N'...' strings. */
  national?: boolean;
}

interface LexResult {
  tokens: Token[];
  /** The query with every comment replaced by spaces (line breaks kept). */
  withoutComments: string;
}

const WHITESPACE_RE = /\s+/uy;
/**
 * Identifiers and keywords. Besides letters, digits, "_", "@", "#" and "$", SQL Server
 * accepts combining marks and connector punctuation (e.g. U+FF3F FULLWIDTH LOW LINE)
 * inside identifiers, so they are kept in the word; none of them separates tokens.
 */
const WORD_RE = /[\p{L}\p{Pc}@#][\p{L}\p{M}\p{Nd}\p{Pc}@#$]*/uy;
/**
 * Numeric literals as SQL Server reads them: the exponent digits are optional, so "1e",
 * "1.e" and "1e+" are complete float literals, and "0x" with no digits is an empty binary.
 */
const NUMBER_RE = /0[xX][0-9a-fA-F]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d*)?/y;
/** Money literals: "$" followed by digits and/or a decimal point. Money takes no exponent. */
const MONEY_RE = /\$(?:\d+(?:\.\d*)?|\.\d*)/y;
const DIGIT_RE = /[0-9]/;
/**
 * Characters that may not directly follow a numeric literal. SQL Server ends a literal at
 * the first character it cannot extend it with, so a word glued to a literal ("1e" then
 * "delete") starts a new token; such input is rejected rather than split.
 */
const GLUED_TO_LITERAL_RE = /[\p{L}\p{M}\p{N}_@#$]/u;
/**
 * Control and invisible characters that SQL Server treats as token separators although
 * they are not whitespace in JavaScript (C0 controls other than TAB, LF, VT, FF and CR,
 * NEL and ZERO WIDTH SPACE), plus BYTE ORDER MARK, which is whitespace in JavaScript but
 * not in SQL Server. They are rejected outside strings, comments and quoted identifiers.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this pattern
const SEPARATOR_MISMATCH_RE = /[\u0000-\u0008\u000e-\u001f\u0085\u200b\ufeff]/;

/**
 * Characters that some software treats as a line break: lone CR, VT, FF, NEL, LINE
 * SEPARATOR and PARAGRAPH SEPARATOR. Whether they end a "--" comment is unclear, so a
 * "--" comment containing one is rejected.
 */
const AMBIGUOUS_LINE_BREAKS: ReadonlySet<string> = new Set(
  [0x0d, 0x0b, 0x0c, 0x85, 0x2028, 0x2029].map((code) => String.fromCharCode(code)),
);

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function where(source: string, offset: number): string {
  const { line, column } = lineAndColumn(source, offset);
  return `line ${line}, column ${column}`;
}

function reject(message: string, errorType: ErrorType, details: Record<string, unknown>): never {
  throw new MssqlMcpError(message, errorType, undefined, details);
}

function codePointName(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Tokenises a query with SQL Server's lexical rules: '' is the only escape in strings
 * (backslash is an ordinary character), [ ] and " " delimit identifiers with ]] and ""
 * as escapes, "--" comments run to the end of the line, and /* *\/ comments nest.
 * Throws on unterminated strings, identifiers and comments, and on comments whose
 * extent could be read differently ("/*" inside a "--" comment, "--" inside a /* *\/
 * comment, or an unusual line break inside a "--" comment).
 */
function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const pieces: string[] = [];
  const n = source.length;
  let i = 0;
  let copiedUpTo = 0;

  const blankOutComment = (start: number, end: number): void => {
    pieces.push(source.slice(copiedUpTo, start), source.slice(start, end).replace(/[^\r\n]/g, ' '));
    copiedUpTo = end;
  };

  const matchAt = (re: RegExp, at: number): string | null => {
    re.lastIndex = at;
    return re.exec(source)?.[0] ?? null;
  };

  /** Reads up to the closing delimiter, where a doubled delimiter stands for one literal delimiter. */
  const readDelimited = (contentStart: number, close: string): { value: string; end: number } | null => {
    let value = '';
    let j = contentStart;
    while (j < n) {
      if (source[j] === close) {
        if (source[j + 1] !== close) return { value, end: j + 1 };
        value += close;
        j += 2;
      } else {
        value += source[j];
        j++;
      }
    }
    return null;
  };

  const pushNumber = (length: number): void => {
    const end = i + length;
    const following = source[end];
    if (following !== undefined && GLUED_TO_LITERAL_RE.test(following)) {
      const literal = source.slice(i, end);
      reject(
        `Query rejected: the numeric literal "${literal}" at ${where(source, i)} is directly followed by "${following}" with no space. SQL Server ends the literal there and reads what follows as a separate token. Put a space after the literal, or bracket the name.`,
        ErrorType.VALIDATION_ERROR,
        { reason: 'glued_literal', position: i },
      );
    }
    tokens.push({ kind: 'number', start: i, end });
    i = end;
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (SEPARATOR_MISMATCH_RE.test(c)) {
      reject(
        `Query rejected: the query contains the control or invisible character ${codePointName(c)} at ${where(source, i)}. SQL Server treats it as a separator, which this validator does not support. Use ordinary spaces and line breaks.`,
        ErrorType.VALIDATION_ERROR,
        { reason: 'unsupported_character', position: i },
      );
    }

    const whitespace = matchAt(WHITESPACE_RE, i);
    if (whitespace) {
      i += whitespace.length;
      continue;
    }

    if (c === '-' && next === '-') {
      const start = i;
      i += 2;
      while (i < n && source[i] !== '\n') {
        const ch = source[i];
        if (ch === '\r' && source[i + 1] === '\n') break;
        if (AMBIGUOUS_LINE_BREAKS.has(ch)) {
          reject(
            `Query rejected: the "--" comment at ${where(source, start)} contains an unusual line-break character (${codePointName(ch)}), so it is unclear where the comment ends. Use plain line breaks (LF or CR LF) or remove the comment.`,
            ErrorType.VALIDATION_ERROR,
            { reason: 'ambiguous_comment', position: start },
          );
        }
        if (ch === '/' && source[i + 1] === '*') {
          reject(
            `Query rejected: the "--" comment at ${where(source, start)} contains "/*". Remove the comment or the "/*" inside it.`,
            ErrorType.VALIDATION_ERROR,
            { reason: 'ambiguous_comment', position: start },
          );
        }
        i++;
      }
      blankOutComment(start, i);
      continue;
    }

    if (c === '/' && next === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const pair = source.slice(i, i + 2);
        if (pair === '/*') {
          depth++;
          i += 2;
        } else if (pair === '*/') {
          depth--;
          i += 2;
        } else if (pair === '--') {
          reject(
            `Query rejected: the /* */ comment at ${where(source, start)} contains "--". Remove the comment or the "--" inside it.`,
            ErrorType.VALIDATION_ERROR,
            { reason: 'ambiguous_comment', position: start },
          );
        } else {
          i++;
        }
      }
      if (depth > 0) {
        reject(
          `Query rejected: the /* comment at ${where(source, start)} is never closed. /* */ comments nest in T-SQL, so every /* needs its own */.`,
          ErrorType.VALIDATION_ERROR,
          { reason: 'unterminated_comment', position: start },
        );
      }
      blankOutComment(start, i);
      continue;
    }

    const national = (c === 'N' || c === 'n') && next === "'";
    if (c === "'" || national) {
      const read = readDelimited(i + (national ? 2 : 1), "'");
      if (read === null) {
        reject(
          `Query rejected: the string literal at ${where(source, i)} is never closed. In T-SQL a quote inside a string is written as two single quotes (''); backslash is not an escape character.`,
          ErrorType.VALIDATION_ERROR,
          { reason: 'unterminated_string', position: i },
        );
      }
      tokens.push({ kind: 'string', start: i, end: read.end, value: read.value, national });
      i = read.end;
      continue;
    }

    if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"';
      const read = readDelimited(i + 1, close);
      if (read === null) {
        reject(
          `Query rejected: the ${c}...${close} identifier at ${where(source, i)} is never closed. Inside it, write ${close} as ${close}${close}.`,
          ErrorType.VALIDATION_ERROR,
          { reason: 'unterminated_identifier', position: i },
        );
      }
      tokens.push({ kind: 'quotedIdentifier', start: i, end: read.end, value: read.value });
      i = read.end;
      continue;
    }

    if (c === ';') {
      tokens.push({ kind: 'semicolon', start: i, end: i + 1 });
      i++;
      continue;
    }

    if (c === '.') {
      const prev = tokens[tokens.length - 1];
      const followsName = prev !== undefined && prev.end === i && (prev.kind === 'word' || prev.kind === 'quotedIdentifier');
      if (!followsName && next !== undefined && DIGIT_RE.test(next)) {
        pushNumber(matchAt(NUMBER_RE, i)!.length);
        continue;
      }
      tokens.push({ kind: 'dot', start: i, end: i + 1 });
      i++;
      continue;
    }

    const word = matchAt(WORD_RE, i);
    if (word) {
      tokens.push({ kind: 'word', start: i, end: i + word.length });
      i += word.length;
      continue;
    }

    const number = matchAt(NUMBER_RE, i) ?? matchAt(MONEY_RE, i);
    if (number) {
      pushNumber(number.length);
      continue;
    }

    const symbol = String.fromCodePoint(source.codePointAt(i)!);
    tokens.push({ kind: 'symbol', start: i, end: i + symbol.length });
    i += symbol.length;
  }

  pieces.push(source.slice(copiedUpTo));
  return { tokens, withoutComments: pieces.join('') };
}

function bracketHint(word: string): string {
  return `If "${word}" is meant as a column, table or alias name, enclose it in square brackets, e.g. [${word}].`;
}

/**
 * Read access to the lexed tokens by index, with the parenthesis structure. Out-of-range
 * indexes read as "no token".
 */
class TokenView {
  /** Paren depth around each token; "(" and ")" get the depth outside the pair. */
  readonly depth: number[] = [];
  /** The index of the matching parenthesis, for every "(" and ")" that has one. */
  readonly partner = new Map<number, number>();
  /** The index of the first ")" without a "(", or of the first "(" never closed; null when balanced. */
  readonly unbalancedAt: number | null;

  constructor(
    readonly source: string,
    readonly tokens: Token[],
  ) {
    const open: number[] = [];
    let depth = 0;
    let unbalancedAt: number | null = null;
    tokens.forEach((_token, index) => {
      if (this.isSymbol(index, '(')) {
        this.depth.push(depth);
        open.push(index);
        depth++;
      } else if (this.isSymbol(index, ')')) {
        const opener = open.pop();
        if (opener === undefined) {
          unbalancedAt ??= index;
        } else {
          this.partner.set(index, opener);
          this.partner.set(opener, index);
          depth--;
        }
        this.depth.push(depth);
      } else {
        this.depth.push(depth);
      }
    });
    this.unbalancedAt = unbalancedAt ?? (open.length > 0 ? open[0] : null);
  }

  text(index: number): string {
    const token = this.tokens[index];
    return token === undefined ? '' : this.source.slice(token.start, token.end);
  }

  kind(index: number): TokenKind | undefined {
    return this.tokens[index]?.kind;
  }

  isSymbol(index: number, symbol: string): boolean {
    return this.kind(index) === 'symbol' && this.text(index) === symbol;
  }

  /**
   * A word folded the way objects are matched (case, accents and width ignored). Used to
   * find words that must be denied or checked, so that look-alike spellings are caught too.
   */
  folded(index: number): string | null {
    return this.kind(index) === 'word' ? foldName(this.text(index)) : null;
  }

  /**
   * A word upper-cased only if it is spelled with ASCII letters and "_". SQL Server reads
   * other spellings (e.g. accented or full-width letters) as names, not keywords, so a
   * keyword is only taken as present, and a query only accepted because of it, if it
   * matches here.
   */
  exact(index: number): string | null {
    const text = this.text(index);
    return this.kind(index) === 'word' && /^[A-Za-z_]+$/.test(text) ? text.toUpperCase() : null;
  }

  /** The value of a TOP clause ends here: "TOP 10" or "TOP (...)". */
  endsTopValue(index: number): boolean {
    if (this.kind(index) === 'number') return this.exact(index - 1) === 'TOP';
    const opener = this.isSymbol(index, ')') ? this.partner.get(index) : undefined;
    return opener !== undefined && this.exact(opener - 1) === 'TOP';
  }

  /** The row count of a TOP clause ends here, including an optional PERCENT. */
  endsTopCount(index: number): boolean {
    return this.endsTopValue(index) || (this.exact(index) === 'PERCENT' && this.endsTopValue(index - 1));
  }

  /** A whole TOP clause ends here, including an optional WITH TIES. */
  endsTopClause(index: number): boolean {
    return this.endsTopCount(index) || (this.exact(index) === 'TIES' && this.exact(index - 1) === 'WITH' && this.endsTopCount(index - 2));
  }

  /**
   * The WITH at this index is part of the statement and cannot start a common table
   * expression: a table hint or OPENJSON schema "WITH (", "WITH ROLLUP", "WITH CUBE", or
   * "WITH TIES" after a TOP count. A CTE name is followed by "AS" or a column list "(",
   * so ROLLUP, CUBE or TIES followed by either is not accepted.
   */
  isInlineWith(index: number): boolean {
    if (this.isSymbol(index + 1, '(')) return true;
    const next = this.exact(index + 1);
    const startsCte = this.isSymbol(index + 2, '(') || this.folded(index + 2) === 'AS';
    if (startsCte) return false;
    return next === 'ROLLUP' || next === 'CUBE' || (next === 'TIES' && this.endsTopCount(index - 1));
  }

  /**
   * A static method call of a system CLR type starts at this index: "geography::Point(",
   * with the type not part of a dotted name, the two ":" written together and the method
   * a plain word directly followed by "(".
   */
  startsStaticMethodCall(index: number): boolean {
    const type = this.exact(index);
    return (
      type !== null &&
      STATIC_METHOD_TYPES.has(type) &&
      this.kind(index - 1) !== 'dot' &&
      this.isSymbol(index + 1, ':') &&
      this.isSymbol(index + 2, ':') &&
      this.tokens[index + 1].end === this.tokens[index + 2].start &&
      this.exact(index + 3) !== null &&
      this.isSymbol(index + 4, '(')
    );
  }

  /** Index of the first token after the run of "(" that starts at this index. */
  afterOpenParens(index: number): number {
    let next = index;
    while (this.isSymbol(next, '(')) next++;
    return next;
  }
}

/**
 * Rejects any place where SQL Server would start a second statement with a keyword that a
 * SELECT also uses: SELECT, WITH, FETCH or "(". T-SQL needs no ";" between statements, so
 * "SELECT 1 SELECT 2" and "SELECT 1 x (SELECT 2)" are both two statements.
 */
function checkStatementBoundaries(view: TokenView, first: number): void {
  const { source, tokens } = view;
  const shown = (index: number): string => view.text(index).slice(0, 40);
  const rejectBoundary = (index: number, message: string): never =>
    reject(
      `Query rejected: ${message} Only one statement is allowed per call.`,
      ErrorType.VALIDATION_ERROR,
      { reason: 'multiple_statements', position: tokens[index].start },
    );

  if (view.unbalancedAt !== null) {
    const index = view.unbalancedAt;
    reject(
      `Query rejected: the "${view.text(index)}" at ${where(source, tokens[index].start)} has no matching parenthesis. Check that every "(" is closed.`,
      ErrorType.VALIDATION_ERROR,
      { reason: 'unbalanced_parentheses', position: tokens[index].start },
    );
  }

  /** A "*" here is a multiplication rather than the select-list "*" (which ends an expression list). */
  const isMultiplication = (star: number): boolean => {
    const operand = star - 1;
    switch (view.kind(operand)) {
      case 'string':
      case 'quotedIdentifier':
        return true;
      case 'number':
        return !view.endsTopValue(operand);
      case 'symbol':
        return view.isSymbol(operand, ')') && !view.endsTopValue(operand);
      case 'word': {
        const word = view.folded(operand);
        return word !== 'SELECT' && word !== 'DISTINCT' && word !== 'ALL' && !view.endsTopClause(operand);
      }
      default:
        return false;
    }
  };

  const isName = (index: number): boolean => view.kind(index) === 'word' || view.kind(index) === 'quotedIdentifier';

  /**
   * The name ending just before this "(" is a function being called: SQL Server reads
   * "name (" as a call where an expression starts. The name is a dotted name, or a plain
   * word that is not a variable and not a keyword that forms a whole expression.
   */
  const isFunctionCall = (paren: number): boolean => {
    const last = paren - 1;
    if (!isName(last)) return false;
    let start = last;
    while (view.kind(start - 1) === 'dot' && isName(start - 2)) start -= 2;
    if (view.kind(start - 1) === 'dot') return false;
    if (start === last) {
      const word = view.exact(last);
      if (word === null || !/^[A-Z_][A-Z0-9_]*$/.test(word) || NOT_CALLABLE_WORDS.has(word)) return false;
      // "geography::Point(" is one call; what precedes the type decides where it stands.
      if (view.startsStaticMethodCall(start - 3)) start -= 3;
    } else if (view.kind(start) === 'word' && /^[@#]/.test(view.text(start))) {
      return false;
    }
    // "$PARTITION.f(" is one name in SQL Server, written as "$" and a word here.
    if (view.exact(start) === 'PARTITION' && view.isSymbol(start - 1, '$') && view.tokens[start - 1].end === view.tokens[start].start) {
      start--;
    }
    return startsExpression(start - 1, false);
  };

  /** A "(" opening a SELECT, at depth 0, follows a token after which it is a subquery. */
  const opensSubquery = (paren: number): boolean => startsExpression(paren - 1, true) || isFunctionCall(paren);

  /**
   * SQL Server starts an expression, or a table source, after this token. With
   * allowAs false, AS is excluded: what follows AS is an alias, except for a CTE body.
   */
  function startsExpression(before: number, allowAs: boolean): boolean {
    switch (view.kind(before)) {
      case 'word': {
        const word = view.exact(before);
        if (word === 'AS' && !allowAs) return false;
        if (word !== null && SUBQUERY_AFTER_KEYWORDS.has(word)) return true;
        if (word === 'APPLY' && (view.exact(before - 1) === 'CROSS' || view.exact(before - 1) === 'OUTER')) return true;
        if (word === 'ZONE' && view.exact(before - 1) === 'TIME' && view.exact(before - 2) === 'AT') return true;
        if (word === 'FN' && view.isSymbol(before - 1, '{')) return true;
        return view.endsTopClause(before);
      }
      case 'number':
        return view.endsTopClause(before);
      case 'symbol': {
        const symbol = view.text(before);
        if (SUBQUERY_AFTER_SYMBOLS.has(symbol)) return true;
        if (symbol === '*') return isMultiplication(before);
        return symbol === ')' && view.endsTopClause(before);
      }
      default:
        return false;
    }
  }

  const startsWithCte = view.exact(first) === 'WITH';
  let mainSelectPending = startsWithCte;

  for (let index = first + 1; index < tokens.length; index++) {
    const keyword = view.folded(index);
    const at = where(source, tokens[index].start);

    if (keyword === 'SELECT') {
      if (mainSelectPending && view.depth[index] === view.depth[first]) {
        // The SELECT that follows the WITH ... AS (...) list.
        mainSelectPending = false;
        if (view.isSymbol(index - 1, ')')) continue;
      } else {
        if (view.isSymbol(index - 1, '(')) continue;
        const before = view.exact(index - 1);
        if (before === 'UNION' || before === 'EXCEPT' || before === 'INTERSECT') continue;
        if (before === 'ALL' && view.exact(index - 2) === 'UNION') continue;
      }
      rejectBoundary(
        index,
        `"${shown(index)}" at ${at} follows "${shown(index - 1)}", so SQL Server reads it as the start of a second statement. Combine queries with UNION, EXCEPT or INTERSECT, or put a subquery in parentheses.`,
      );
    }

    if (keyword === 'WITH' && !view.isInlineWith(index)) {
      rejectBoundary(
        index,
        `"${shown(index)}" at ${at} is not a table hint (WITH (...)), WITH TIES, WITH ROLLUP or WITH CUBE, so SQL Server reads it as the start of a second statement. A WITH clause for common table expressions must start the query.`,
      );
    }

    if (keyword === 'FETCH') {
      const afterRows = view.exact(index - 1) === 'ROWS' || view.exact(index - 1) === 'ROW';
      let offsetBefore = false;
      for (let back = index - 1; back > first && !offsetBefore; back--) {
        offsetBefore = view.depth[back] === view.depth[index] && view.exact(back) === 'OFFSET';
      }
      if (!afterRows || !offsetBefore) {
        rejectBoundary(
          index,
          `"${shown(index)}" at ${at} is not part of ORDER BY ... OFFSET n ROWS FETCH NEXT n ROWS ONLY, so SQL Server reads it as a FETCH statement for a cursor. ${bracketHint(view.text(index))}`,
        );
      }
    }

    if (view.isSymbol(index, '(') && view.depth[index] === 0) {
      const inner = view.folded(view.afterOpenParens(index));
      if ((inner === 'SELECT' || inner === 'WITH') && !opensSubquery(index)) {
        rejectBoundary(
          index,
          `the parenthesised SELECT at ${at} follows "${shown(index - 1)}", where SQL Server ends the statement and reads "(SELECT ...)" as a second one. A subquery has to stand where an expression or table is expected, e.g. after SELECT, FROM, JOIN, WHERE, IN, a comma or an operator.`,
        );
      }
    }
  }
}

/** Applies the statement, first-keyword and denied-keyword rules to the lexed tokens. */
function checkTokens(view: TokenView): void {
  const { source, tokens } = view;
  const textOf = (token: Token): string => source.slice(token.start, token.end);
  const keywordAt = (index: number): string | null => view.folded(index);

  if (tokens.length === 0) {
    reject('Query rejected: the query is empty (or contains only comments). Provide a single SELECT statement.', ErrorType.VALIDATION_ERROR, {
      reason: 'empty_query',
    });
  }

  tokens.forEach((token, index) => {
    const after = tokens[index + 1];
    if (token.kind === 'semicolon' && after !== undefined) {
      reject(
        `Query rejected: only one statement is allowed, but the ";" at ${where(source, token.start)} is followed by more SQL ("${source
          .slice(after.start, after.start + 40)
          .trim()}"). Send one SELECT statement per call; a single trailing ";" is fine.`,
        ErrorType.VALIDATION_ERROR,
        { reason: 'multiple_statements', position: token.start },
      );
    }
  });

  const first = view.afterOpenParens(0);
  const firstKeyword = view.exact(first);
  if (firstKeyword !== 'SELECT' && firstKeyword !== 'WITH') {
    const shown = first < tokens.length ? textOf(tokens[first]) : '(';
    reject(
      `Query rejected: the query must start with SELECT, or with WITH for a common table expression followed by SELECT, but it starts with "${shown}". Only read-only SELECT queries are allowed.`,
      ErrorType.VALIDATION_ERROR,
      { reason: 'not_select', firstToken: shown },
    );
  }

  tokens.forEach((token, index) => {
    const keyword = keywordAt(index);
    if (keyword === null) return;
    const word = textOf(token);

    if (keyword === 'GO') {
      reject(
        `Query rejected: "GO" at ${where(source, token.start)} is a client-side batch separator, not T-SQL, and only one statement is allowed. Remove it. ${bracketHint(word)}`,
        ErrorType.VALIDATION_ERROR,
        { reason: 'batch_separator', keyword, position: token.start },
      );
    }

    if (keyword === 'NEXT' && keywordAt(index + 1) === 'VALUE' && keywordAt(index + 2) === 'FOR') {
      reject(
        `Query rejected: "NEXT VALUE FOR" at ${where(source, token.start)} advances a sequence, a change that a rollback does not undo. Read sys.sequences (current_value) instead.`,
        ErrorType.VALIDATION_ERROR,
        { reason: 'denied_keyword', keyword: 'NEXT VALUE FOR', position: token.start },
      );
    }

    const reason = DENIED_KEYWORDS.get(keyword);
    if (reason !== undefined) {
      reject(
        `Query rejected: "${word}" at ${where(source, token.start)} is not allowed: ${reason}. Only a single read-only SELECT statement can run. ${bracketHint(word)}`,
        ErrorType.VALIDATION_ERROR,
        { reason: 'denied_keyword', keyword, position: token.start },
      );
    }
  });

  tokens.forEach((token) => {
    if (token.kind !== 'word' && token.kind !== 'quotedIdentifier') return;
    const name = token.kind === 'word' ? textOf(token) : token.value!;
    if (DENIED_OBJECTS.has(foldName(name))) {
      reject(
        `Query rejected: "${name.trim()}" at ${where(source, token.start)} is not allowed: it reads server files, transaction logs, backups, traces, audit or Extended Events data, or the server's file system.`,
        ErrorType.VALIDATION_ERROR,
        { reason: 'denied_object', object: name.trim(), position: token.start },
      );
    }
  });

  checkNameChains(source, tokens);
  checkStatementBoundaries(view, first);
}

/**
 * Rejects dotted names with 4 or more parts, counting the empty parts of "a..b". Parts
 * may be separated by whitespace or comments around the dots, as SQL Server allows. A
 * 4-part table name addresses a linked server; a 4-part column name is deprecated syntax
 * and is rejected as well, since it cannot be told apart from a table name here. After a
 * dot, "$PARTITION" counts as a name part.
 */
function checkNameChains(source: string, tokens: Token[]): void {
  const isName = (token: Token): boolean => token.kind === 'word' || token.kind === 'quotedIdentifier';
  const textAt = (index: number): string => (tokens[index] === undefined ? '' : source.slice(tokens[index].start, tokens[index].end));
  /** "$PARTITION" with nothing between "$" and the word, which SQL Server reads as one name. */
  const isPartitionName = (index: number): boolean =>
    tokens[index]?.kind === 'symbol' &&
    textAt(index) === '$' &&
    tokens[index + 1]?.kind === 'word' &&
    textAt(index + 1).toUpperCase() === 'PARTITION' &&
    tokens[index + 1].start === tokens[index].end;
  let index = 0;
  while (index < tokens.length) {
    const start = tokens[index];
    if (!isName(start) && start.kind !== 'dot') {
      index++;
      continue;
    }
    let dots = 0;
    let previous: Token | undefined;
    let end = index;
    while (end < tokens.length) {
      const token = tokens[end];
      if (previous?.kind === 'dot' && isPartitionName(end)) {
        previous = tokens[end + 1];
        end += 2;
        continue;
      }
      if (token.kind === 'dot') dots++;
      else if (!isName(token) || (previous !== undefined && isName(previous))) break;
      previous = token;
      end++;
    }
    if (dots >= 3) {
      const shown = source.slice(start.start, tokens[end - 1].end).replace(/\s+/g, ' ');
      reject(
        `Query rejected: "${shown}" at ${where(source, start.start)} is a name with ${dots + 1} parts. Names of the form [server].[database].[schema].[object] refer to a linked server, which is not allowed. Use names of the form [database].[schema].[object] or shorter, and table aliases for columns.`,
        ErrorType.PERMISSION_ERROR,
        { reason: 'linked_server', name: shown, position: start.start },
      );
    }
    index = Math.max(end, index + 1);
  }
}

/**
 * Rebuilds the query for node-sql-parser so that it reads the structure SQL Server reads:
 * comments are blanked out, backslashes in strings are doubled (node-sql-parser treats a
 * backslash as an escape), quoted identifiers are written as [ ] without the "]]" escape,
 * the empty schema part of "db..table" is filled with "dbo", the whitespace between tokens
 * becomes plain spaces and line feeds, and numeric literals get the digits that SQL Server
 * treats as implied ("1." as "1.0", ".5" as "0.5", "1e" as "1e0", "$.5" as "$0.5").
 * Tokens listed in rewrites are written as the given text instead.
 */
function toParserText(source: string, lexed: LexResult, rewrites: ReadonlyMap<number, string>): string {
  const text = lexed.withoutComments;
  const out: string[] = [];
  let copied = 0;
  let previous: Token | undefined;
  lexed.tokens.forEach((token, index) => {
    out.push(text.slice(copied, token.start).replace(/[^\n]/g, ' '));
    const rewrite = rewrites.get(index);
    if (rewrite !== undefined) {
      out.push(rewrite);
    } else if (token.kind === 'number') {
      out.push(completeNumber(source.slice(token.start, token.end)));
    } else if (token.kind === 'string') {
      out.push(`${token.national ? 'N' : ''}'${token.value!.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);
    } else if (token.kind === 'quotedIdentifier') {
      out.push(`[${token.value!.replace(/]/g, BRACKET_ESCAPE_PLACEHOLDER)}]`);
    } else if (token.kind === 'dot' && previous?.kind === 'dot') {
      out.push('dbo.');
    } else {
      out.push(source.slice(token.start, token.end));
    }
    copied = token.end;
    previous = token;
  });
  out.push(text.slice(copied));
  return out.join('');
}

/** Index of the "}" that closes the "{" at this index, or null if it is never closed. */
function closingBrace(view: TokenView, open: number): number | null {
  let depth = 0;
  for (let index = open; index < view.tokens.length; index++) {
    if (view.isSymbol(index, '{')) depth++;
    else if (view.isSymbol(index, '}') && --depth === 0) return index;
  }
  return null;
}

/** The tokens in [from, to) hold no subquery and no name of 3 or more parts. */
function isPlainHintList(view: TokenView, from: number, to: number): boolean {
  for (let index = from; index < to; index++) {
    const word = view.folded(index);
    if (word === 'SELECT' || word === 'FROM') return false;
    if (view.kind(index) === 'dot' && (view.kind(index + 1) === 'dot' || view.kind(index + 2) === 'dot')) return false;
  }
  return true;
}

/**
 * The word at this index is the whole target type of a CAST or TRY_CAST: it follows AS
 * and is followed by the ")" that closes "CAST(".
 */
function isCastTargetType(view: TokenView, index: number): boolean {
  if (view.exact(index - 1) !== 'AS' || !view.isSymbol(index + 1, ')')) return false;
  const opener = view.partner.get(index + 1);
  if (opener === undefined) return false;
  const name = view.exact(opener - 1);
  return (name === 'CAST' || name === 'TRY_CAST') && view.kind(opener - 2) !== 'dot';
}

/**
 * Replacements, by token index, that let node-sql-parser read T-SQL syntax it lacks. Each
 * keeps every token that can name a table, column, function or subquery, so the whitelist
 * and INTO checks still see all of them; only keywords and punctuation that name nothing
 * are replaced or blanked. The lexer checks run on the original text.
 * - EXCEPT and INTERSECT become UNION, which combines the same two queries.
 * - TRY_CAST(x AS t) becomes CAST(x AS t).
 * - A CAST or TRY_CAST target type in CAST_TYPES_PARSER_LACKS, such as xml, becomes INT.
 * - "geography::Point(x)" (any type in STATIC_METHOD_TYPES) becomes "geography.Point(x)",
 *   a 2-part function name.
 * - The "." of a method called on a call result, "f(x).Method(y)", becomes "+", so
 *   that the method reads as a function call: "f(x) + Method(y)".
 * - STRING_AGG(...) WITHIN GROUP (ORDER BY ...) gets another function name, since the
 *   parser reads WITHIN GROUP after any function except STRING_AGG.
 * - "x AT TIME ZONE y" becomes "x + y".
 * - The "{fn" and "}" around an ODBC scalar function are blanked.
 * - "$PARTITION.f(x)" becomes "_PARTITION.f(x)", a 2-part function name.
 * - WITH TIES after a TOP count, WITH ROLLUP and WITH CUBE are blanked.
 * - A final OPTION (...) query hint clause is blanked when it holds no subquery and no
 *   name of 3 or more parts.
 * - A system function such as @@VERSION, outside a dotted name, becomes the number 0; the
 *   parser cannot read one followed by AS or an alias.
 */
function parserRewrites(view: TokenView): Map<number, string> {
  const { tokens } = view;
  const rewrites = new Map<number, string>();
  const blank = (index: number): void => {
    rewrites.set(index, ' '.repeat(tokens[index].end - tokens[index].start));
  };
  const first = view.afterOpenParens(0);

  for (let index = 0; index < tokens.length; index++) {
    if (rewrites.has(index)) continue;
    const word = view.exact(index);
    const afterDot = view.kind(index - 1) === 'dot';

    if (
      view.kind(index) === 'word' &&
      /^@@[A-Za-z_]+$/.test(view.text(index)) &&
      !afterDot &&
      view.kind(index + 1) !== 'dot'
    ) {
      rewrites.set(index, '0'.padEnd(view.text(index).length));
    } else if (word === 'EXCEPT' || word === 'INTERSECT') {
      rewrites.set(index, 'UNION'.padEnd(word.length));
    } else if (word === 'TRY_CAST' && !afterDot && view.isSymbol(index + 1, '(')) {
      rewrites.set(index, 'CAST'.padEnd(word.length));
    } else if (word !== null && CAST_TYPES_PARSER_LACKS.has(word) && isCastTargetType(view, index)) {
      rewrites.set(index, 'INT'.padEnd(word.length));
    } else if (view.startsStaticMethodCall(index)) {
      rewrites.set(index + 1, '.');
      blank(index + 2);
    } else if (
      view.kind(index) === 'dot' &&
      view.isSymbol(index - 1, ')') &&
      view.exact(index + 1) !== null &&
      view.isSymbol(index + 2, '(')
    ) {
      rewrites.set(index, '+');
    } else if (word === 'STRING_AGG' && !afterDot && view.isSymbol(index + 1, '(')) {
      const close = view.partner.get(index + 1);
      if (close !== undefined && view.exact(close + 1) === 'WITHIN' && view.exact(close + 2) === 'GROUP') {
        rewrites.set(index, 'STRINGAGG_');
      }
    } else if (word === 'AT' && index > first && view.exact(index + 1) === 'TIME' && view.exact(index + 2) === 'ZONE') {
      rewrites.set(index, '+ ');
      blank(index + 1);
      blank(index + 2);
    } else if (view.isSymbol(index, '{') && view.exact(index + 1) === 'FN') {
      const close = closingBrace(view, index);
      if (close !== null) {
        blank(index);
        blank(index + 1);
        blank(close);
      }
    } else if (
      view.isSymbol(index, '$') &&
      !afterDot &&
      view.exact(index + 1) === 'PARTITION' &&
      tokens[index + 1].start === tokens[index].end &&
      view.kind(index + 2) === 'dot'
    ) {
      rewrites.set(index, '_');
    } else if (word === 'WITH' && index !== first && !view.isSymbol(index + 1, '(') && view.isInlineWith(index)) {
      blank(index);
      blank(index + 1);
    } else if (word === 'OPTION' && view.depth[index] === 0 && view.isSymbol(index + 1, '(')) {
      const close = view.partner.get(index + 1);
      if (close === undefined) continue;
      const last = view.kind(close + 1) === 'semicolon' ? close + 1 : close;
      if (last === tokens.length - 1 && isPlainHintList(view, index + 2, close)) {
        for (let hint = index; hint <= close; hint++) blank(hint);
      }
    }
  }
  return rewrites;
}

/**
 * T-SQL constructs in the query that node-sql-parser cannot read, even after
 * parserRewrites, described for the caller.
 */
function unsupportedConstructs(view: TokenView, rewrites: ReadonlyMap<number, string>): string[] {
  const found = new Set<string>();
  const isName = (index: number): boolean => view.kind(index) === 'word' || view.kind(index) === 'quotedIdentifier';
  view.tokens.forEach((_token, index) => {
    const word = view.exact(index);
    if (
      isName(index) &&
      view.kind(index - 1) !== 'dot' &&
      view.kind(index + 1) === 'dot' &&
      isName(index + 2) &&
      view.kind(index + 3) === 'dot' &&
      isName(index + 4) &&
      view.isSymbol(index + 5, '(')
    ) {
      found.add('3-part names followed by "(", such as database.schema.function(...) or alias.column.method(...)');
    }
    if ((word === 'PARSE' || word === 'TRY_PARSE') && view.isSymbol(index + 1, '(')) found.add('PARSE and TRY_PARSE');
    if (view.isSymbol(index, '{') && !rewrites.has(index)) {
      found.add('ODBC escape sequences other than {fn ...}, such as {d ...}, {ts ...} or {oj ...}');
    }
    if (view.isSymbol(index, '$') && view.exact(index + 1) === 'PARTITION' && !rewrites.has(index)) {
      found.add('$PARTITION with a database name');
    }
    if (view.isSymbol(index, ':') && view.isSymbol(index + 1, ':') && !rewrites.has(index)) {
      found.add('"::" other than in a static method call of geography, geometry or hierarchyid, such as geography::Point(...)');
    }
    if (word === 'TABLESAMPLE') found.add('TABLESAMPLE');
    if (word === 'XMLNAMESPACES') found.add('WITH XMLNAMESPACES');
    if (word === 'GROUPING' && view.exact(index + 1) === 'SETS') found.add('GROUPING SETS');
    if (word === 'CHANGETABLE') found.add('CHANGETABLE');
    if (word === 'DISTINCT' && view.exact(index + 1) === 'FROM') found.add('IS [NOT] DISTINCT FROM');
    if (word === 'OPENJSON' && view.isSymbol(index + 1, '(')) {
      const close = view.partner.get(index + 1);
      if (close !== undefined && view.exact(close + 1) === 'WITH' && view.isSymbol(close + 2, '(')) {
        found.add('OPENJSON ... WITH (...) column definitions');
      }
    }
    if (word === 'OPTION' && view.isSymbol(index + 1, '(') && !rewrites.has(index)) {
      found.add('OPTION (...) other than as the last clause, or holding a subquery or a name of 3 or more parts');
    }
    if ((word === 'JSON' || word === 'XML') && view.exact(index - 1) === 'FOR') {
      for (let next = index + 1; next < view.tokens.length && view.depth[next] >= view.depth[index]; next++) {
        if (view.depth[next] === view.depth[index] && view.isSymbol(next, ',')) {
          found.add('FOR JSON or FOR XML options after a comma, such as ROOT(...) or INCLUDE_NULL_VALUES');
          break;
        }
      }
    }
  });
  return [...found];
}

const UNSUPPORTED_EXAMPLES =
  '3-part function names, PARSE/TRY_PARSE, ODBC escapes other than {fn ...}, TABLESAMPLE, WITH XMLNAMESPACES, GROUPING SETS, CHANGETABLE, OPENJSON ... WITH (...), XML methods such as .nodes() in FROM, and FOR JSON/XML options after a comma';

/** Rejects a query that node-sql-parser could not read as one SELECT statement. */
function rejectUnreadable(problem: string, constructs: string[], cause: Error | undefined, details: Record<string, unknown>): never {
  const advice =
    constructs.length > 0
      ? `The query uses syntax that the validator's SQL parser does not support: ${constructs.join('; ')}. Rewrite the query without it.`
      : `The validator accepts a single SELECT statement, but its SQL parser does not support some valid T-SQL syntax, for example ${UNSUPPORTED_EXAMPLES}. Rewrite the query with simpler constructs.`;
  throw new MssqlMcpError(`Query rejected: ${problem}. ${advice}`, ErrorType.SQL_PARSER_ERROR, cause, {
    reason: 'parse_error',
    unsupported: constructs,
    ...details,
  });
}

/** Adds the digits SQL Server treats as implied in a decimal, float or money literal; the value is unchanged. */
function completeNumber(literal: string): string {
  if (/^0x/i.test(literal)) return literal;
  const money = literal.startsWith('$');
  let digits = money ? literal.slice(1) : literal;
  if (digits.startsWith('.')) digits = `0${digits}`;
  digits = digits.replace(/\.(?=[eE]|$)/, '.0').replace(/[eE][+-]?$/, (exponent) => `${exponent}0`);
  return money ? `$${digits}` : digits;
}

function rejectParseError(error: unknown, parserText: string, constructs: string[]): never {
  const raw = error instanceof Error ? error.message : String(error);
  const found = /but (.+) found\.?$/s.exec(raw)?.[1];
  const offset = (error as { location?: { start?: { offset?: unknown } } } | null)?.location?.start?.offset;
  let near = '';
  if (typeof offset === 'number') {
    const snippet = parserText.slice(Math.max(0, offset - 30), offset + 30).replace(/\s+/g, ' ').trim();
    near = ` near "${snippet}"${found ? ` (unexpected ${found})` : ''}`;
  } else if (found) {
    near = ` (unexpected ${found})`;
  }
  rejectUnreadable(`the SQL validator could not parse the query${near}`, constructs, error instanceof Error ? error : undefined, {
    parserMessage: raw.slice(0, 500),
  });
}

function nameOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
    return (value as { value: string }).value;
  }
  return null;
}

function decodeIdentifier(name: string): string {
  return name.split(BRACKET_ESCAPE_PLACEHOLDER).join(']');
}

function intoIsSet(into: unknown): boolean {
  if (into === null || into === undefined) return false;
  if (typeof into !== 'object') return true;
  const { expr, position, type } = into as { expr?: unknown; position?: unknown; type?: unknown };
  return (expr !== null && expr !== undefined) || (position !== null && position !== undefined) || type === 'into';
}

/**
 * The database name is on the allow-list, spelled exactly as listed. SQL Server ignores
 * trailing spaces when it compares names, but not leading ones: [mydb ] is mydb, while
 * [ mydb] is a different database. Letter case must match too, since on a case-sensitive
 * server a name that differs only in case is a different database.
 */
function isDatabaseAllowed(database: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(database.replace(/ +$/, ''));
}

/**
 * For a name that is not on the allow-list but matches an entry when letter case is
 * ignored, a sentence naming the spelling to use; otherwise an empty string.
 */
function spellingAdvice(database: string, allowed: ReadonlySet<string>): string {
  const spelling = allowListSpelling(database, allowed);
  if (spelling === undefined) return '';
  return ` Database names in the query must be written exactly as in that list, because on a case-sensitive server a name that differs only in letter case is a different database: use [${spelling.replace(/]/g, ']]')}].`;
}

/** The allow-list entry that matches the name when letter case is ignored, if any. */
function allowListSpelling(database: string, allowed: ReadonlySet<string>): string | undefined {
  const lower = database.replace(/ +$/, '').toLowerCase();
  return [...allowed].find((entry) => entry.toLowerCase() === lower);
}

/** Details of a database_not_allowed rejection: the allow-list spelling, when the name differs from it only in case. */
function spellingDetails(database: string, allowed: ReadonlySet<string>): { allowedSpelling?: string } {
  const spelling = allowListSpelling(database, allowed);
  return spelling === undefined ? {} : { allowedSpelling: spelling };
}

/**
 * Walks the whole AST: rejects SELECT ... INTO and non-SELECT statements at any depth,
 * linked-server (4-part) names, and database names outside the whitelist.
 */
function checkAst(root: unknown, options: ReadOnlyQueryOptions): void {
  const allowed = new Set(options.allowedDatabases);
  const seen = new Set<object>();

  const checkDatabase = (database: string): void => {
    const decoded = decodeIdentifier(database);
    if (!isDatabaseAllowed(decoded, allowed)) {
      reject(
        `Query rejected: database "${decoded}" is not in the list of databases this server may access (${options.allowedDatabases.join(', ')}). Query only those databases, or use 1- or 2-part names for the current database.${spellingAdvice(decoded, allowed)}`,
        ErrorType.PERMISSION_ERROR,
        {
          reason: 'database_not_allowed',
          database: decoded,
          allowedDatabases: [...options.allowedDatabases],
          ...spellingDetails(decoded, allowed),
        },
      );
    }
  };

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const obj = node as Record<string, unknown>;

    if (obj.type === 'select' && intoIsSet(obj.into)) {
      reject(
        'Query rejected: SELECT ... INTO creates a table and is not allowed. Remove the INTO clause to return the rows directly.',
        ErrorType.VALIDATION_ERROR,
        { reason: 'select_into' },
      );
    }

    const nested = obj.ast;
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedType = (nested as { type?: unknown }).type;
      if (nestedType !== undefined && nestedType !== 'select') {
        reject(
          `Query rejected: a nested "${String(nestedType)}" statement was found. Subqueries and common table expressions must be SELECT queries.`,
          ErrorType.VALIDATION_ERROR,
          { reason: 'nested_non_select', statementType: nestedType },
        );
      }
    }

    const server = nameOf(obj.server);
    if (server) {
      const decoded = decodeIdentifier(server);
      reject(
        `Query rejected: "${decoded}" in a 4-part name refers to a linked server, which is not allowed. Use names of the form [database].[schema].[object] or shorter.`,
        ErrorType.PERMISSION_ERROR,
        { reason: 'linked_server', server: decoded },
      );
    }

    if (allowed.size > 0 && 'table' in obj) {
      // In table references the transactsql AST puts the schema of a 2-part name in "db";
      // "db" holds the database only when "schema" is also set. Column references always
      // keep the database in "db".
      const database = obj.type === 'column_ref' || nameOf(obj.schema) !== null ? nameOf(obj.db) : null;
      if (database !== null) checkDatabase(database);
    }

    if (obj.type === 'function') {
      const nameParts = (obj.name as { name?: unknown } | null)?.name;
      const lastPart = Array.isArray(nameParts) ? nameOf(nameParts[nameParts.length - 1]) : null;
      const args = (obj.args as { value?: unknown } | null)?.value;
      const firstArgument = Array.isArray(args) ? (args[0] as Record<string, unknown> | undefined) : undefined;
      if (lastPart !== null && TABLE_ARGUMENT_FUNCTIONS.has(lastPart.toUpperCase()) && firstArgument?.type === 'column_ref') {
        // The table name is parsed as a column reference: a 3-part name a.b.c becomes
        // schema "a", table "b", column "c", and a 4-part name puts its first part in "db".
        const linkedServer = nameOf(firstArgument.db);
        if (linkedServer !== null) {
          const decoded = decodeIdentifier(linkedServer);
          reject(
            `Query rejected: "${decoded}" in a 4-part name refers to a linked server, which is not allowed. Use names of the form [database].[schema].[object] or shorter.`,
            ErrorType.PERMISSION_ERROR,
            { reason: 'linked_server', server: decoded },
          );
        }
        const database = nameOf(firstArgument.table) !== null ? nameOf(firstArgument.schema) : null;
        if (allowed.size > 0 && database !== null) checkDatabase(database);
      }
    }

    Object.values(obj).forEach(visit);
  };

  visit(root);
}

/**
 * Catalog views, compatibility views, dynamic management views and system functions that
 * show the names, ids, data or query text of every database on the server, matched like
 * DENIED_OBJECTS. sys.databases is matched separately, since "databases" alone is a common
 * table name.
 */
const SERVER_SCOPED_OBJECTS: ReadonlySet<string> = new Set(
  [
    'sysdatabases',
    'master_files',
    'sysaltfiles',
    'sysprocesses',
    'syslockinfo',
    'syscacheobjects',
    'sysperfinfo',
    'database_mirroring',
    'database_mirroring_witnesses',
    'database_recovery_status',
    'availability_databases_cluster',
    'dm_database_encryption_keys',
    'dm_db_index_usage_stats',
    'dm_db_index_physical_stats',
    'dm_db_index_operational_stats',
    'dm_db_page_info',
    'dm_db_database_page_allocations',
    'dm_db_log_info',
    'dm_db_log_stats',
    'dm_db_mirroring_auto_page_repair',
    'dm_io_virtual_file_stats',
    'dm_os_buffer_descriptors',
    'dm_os_buffer_pool_extension_pages',
    'dm_os_performance_counters',
    'dm_os_volume_stats',
    'dm_os_waiting_tasks',
    'dm_broker_activated_tasks',
    'dm_broker_queue_monitors',
    'dm_clr_appdomains',
    'dm_qn_subscriptions',
    'dm_server_suspend_status',
    'fn_virtualfilestats',
    'fn_get_sql',
  ].map((name) => name.toUpperCase()),
);

/** Name prefixes of dynamic management views and functions that cover every database on the server. */
const SERVER_SCOPED_PREFIXES: readonly string[] = ['DM_EXEC_', 'DM_XE_', 'DM_DB_MISSING_INDEX_', 'DM_TRAN_', 'DM_HADR_', 'DM_FTS_'];

/**
 * How a function argument can name a database:
 * - name: a string holding a [database].[schema].[object] name;
 * - database: a string holding only a database name;
 * - dbIdCall: a database id, accepted only as a DB_ID(...) call, which is checked by its
 *   own rule.
 */
type DatabaseArgumentKind = 'name' | 'database' | 'dbIdCall';

/**
 * System functions that can read another database through an argument, with the position
 * and kind of that argument. An omitted argument means the current database.
 * HAS_PERMS_BY_NAME and FN_MY_PERMISSIONS are handled separately (PERMISSION_FUNCTIONS).
 * Functions whose arguments only resolve in the current database, such as
 * COLUMNPROPERTY(id, ...), OBJECTPROPERTY(id, ...) and FILEPROPERTY(file_name, ...), are
 * not listed: any expression there stays in the current database.
 */
const DATABASE_ARGUMENT_FUNCTIONS: ReadonlyMap<string, { index: number; kind: DatabaseArgumentKind }> = new Map([
  ['OBJECT_ID', { index: 0, kind: 'name' }],
  ['COL_LENGTH', { index: 0, kind: 'name' }],
  ['DB_ID', { index: 0, kind: 'database' }],
  ['DATABASEPROPERTYEX', { index: 0, kind: 'database' }],
  ['DATABASEPROPERTY', { index: 0, kind: 'database' }],
  ['HAS_DBACCESS', { index: 0, kind: 'database' }],
  ['FN_HADR_IS_PRIMARY_REPLICA', { index: 0, kind: 'database' }],
  ['FN_HADR_BACKUP_IS_PREFERRED_REPLICA', { index: 0, kind: 'database' }],
  ['FN_DB_BACKUP_FILE_SNAPSHOTS', { index: 0, kind: 'database' }],
  ['DB_NAME', { index: 0, kind: 'dbIdCall' }],
  ['OBJECT_NAME', { index: 1, kind: 'dbIdCall' }],
  ['OBJECT_SCHEMA_NAME', { index: 1, kind: 'dbIdCall' }],
]);

/**
 * Permission functions whose first argument is a securable and whose second is its class.
 * For the DATABASE class the securable is a database name; for other classes it may be a
 * [database].[schema].[object] name. A NULL or DEFAULT securable means the server or the
 * current database.
 */
const PERMISSION_FUNCTIONS: ReadonlySet<string> = new Set(['HAS_PERMS_BY_NAME', 'FN_MY_PERMISSIONS']);

const ALLOW_LIST_NOTE = 'This check applies because a database allow-list (SQL_ALLOWED_DATABASES) is configured.';

/**
 * Splits a multipart name held in a string the way SQL Server reads it: parts are
 * separated by ".", and a part may be delimited by [ ] or " " with "]]" or '""' as the
 * escape. Returns null when the text cannot be read that way.
 */
function splitMultipartName(text: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const open = text[i];
    if (open === '[' || open === '"') {
      const close = open === '[' ? ']' : '"';
      let part = '';
      let j = i + 1;
      for (;;) {
        if (j >= text.length) return null;
        if (text[j] === close) {
          if (text[j + 1] !== close) break;
          part += close;
          j += 2;
        } else {
          part += text[j];
          j++;
        }
      }
      parts.push(part);
      i = j + 1;
    } else {
      const end = text.indexOf('.', i);
      const part = text.slice(i, end === -1 ? text.length : end);
      if (/[[\]"]/.test(part)) return null;
      parts.push(part);
      i = end === -1 ? text.length : end;
    }
    if (i >= text.length) return parts;
    if (text[i] !== '.') return null;
    i++;
    if (i >= text.length) {
      parts.push('');
      return parts;
    }
  }
}

/** The tokens of each argument of the call whose "(" is at this index, as [from, to) ranges. */
function callArguments(view: TokenView, open: number): Array<[number, number]> {
  const close = view.partner.get(open)!;
  if (close === open + 1) return [];
  const args: Array<[number, number]> = [];
  let from = open + 1;
  for (let index = open + 1; index < close; index++) {
    if (view.depth[index] === view.depth[open] + 1 && view.isSymbol(index, ',')) {
      args.push([from, index]);
      from = index + 1;
    }
  }
  args.push([from, close]);
  return args;
}

/** The name, folded, of a word or quoted identifier token; null for other tokens. */
function foldedName(view: TokenView, index: number): string | null {
  const token = view.tokens[index];
  if (token?.kind === 'word') return foldName(view.text(index));
  if (token?.kind === 'quotedIdentifier') return foldName(token.value!);
  return null;
}

/** The tokens in [from, to) are exactly one call of the named function. */
function isCallTo(view: TokenView, from: number, to: number, name: string): boolean {
  return to - from >= 3 && foldedName(view, from) === name && view.isSymbol(from + 1, '(') && view.partner.get(from + 1) === to - 1;
}

/**
 * Rejects ways to reach databases outside the allow-list that 3-part names do not show:
 * database and object names passed as strings to system functions, server-wide catalog
 * and dynamic management views, and global temporary tables, which live in tempdb.
 */
function checkAllowListReach(view: TokenView, options: ReadOnlyQueryOptions): void {
  const { source, tokens } = view;
  const allowed = new Set(options.allowedDatabases);
  const listed = options.allowedDatabases.join(', ');
  const tempdbAllowed = allowed.has('tempdb');
  const at = (index: number): string => where(source, tokens[index].start);

  const rejectGlobalTemp = (name: string, index: number): never =>
    reject(
      `Query rejected: "${name}" at ${at(index)} is a global temporary table. Global temporary tables live in tempdb, which is not in the list of databases this server may access (${listed}), and any session can create or read them. ${ALLOW_LIST_NOTE}`,
      ErrorType.PERMISSION_ERROR,
      { reason: 'global_temp_table', name, position: tokens[index].start },
    );

  /** A call of a function listed in DATABASE_ARGUMENT_FUNCTIONS or PERMISSION_FUNCTIONS. */
  interface Call {
    fn: string;
    /** Index of the function name token. */
    index: number;
  }

  /** The statement says what in the call cannot be checked; it ends before ", so ...". */
  const rejectUnverifiable = (call: Call, statement: string, hint: string): never =>
    reject(
      `Query rejected: ${statement}, so the database it refers to cannot be checked. ${hint} ${ALLOW_LIST_NOTE}`,
      ErrorType.PERMISSION_ERROR,
      { reason: 'unverifiable_database_reference', function: call.fn, position: tokens[call.index].start },
    );

  const rejectDatabase = (call: Call, value: string, database: string, wholeName = false): never =>
    reject(
      `Query rejected: the name '${value}' passed to ${call.fn} at ${at(call.index)} refers to database "${database}", which is not in the list of databases this server may access (${listed}). ${wholeName ? `The string must be the bare database name, exactly as listed, without [ ], quotes or spaces.` : `Names passed to ${call.fn} as strings are checked like names in the query.`}${spellingAdvice(database, allowed)} ${ALLOW_LIST_NOTE}`,
      ErrorType.PERMISSION_ERROR,
      {
        reason: 'database_not_allowed',
        database,
        function: call.fn,
        position: tokens[call.index].start,
        ...spellingDetails(database, allowed),
      },
    );

  const literalArgument = (call: Call, range: [number, number], ordinal: string, hint: string): string => {
    const [from, to] = range;
    if (to - from !== 1 || view.kind(from) !== 'string') {
      rejectUnverifiable(call, `the ${ordinal} argument of ${call.fn} at ${at(call.index)} is not a string literal`, hint);
    }
    return tokens[from].value!;
  };

  const checkNameString = (call: Call, value: string): void => {
    const parts = splitMultipartName(value);
    if (parts === null || parts.length > 4) {
      return rejectUnverifiable(
        call,
        `the name '${value}' passed to ${call.fn} at ${at(call.index)} cannot be read as a name of the form [database].[schema].[object]`,
        'Write each part plainly or in [ ], separated by ".".',
      );
    }
    if (parts.length === 4) {
      reject(
        `Query rejected: the name '${value}' passed to ${call.fn} at ${at(call.index)} has 4 parts, so it refers to a linked server, which is not allowed. Use names of the form [database].[schema].[object] or shorter. ${ALLOW_LIST_NOTE}`,
        ErrorType.PERMISSION_ERROR,
        { reason: 'linked_server', function: call.fn, position: tokens[call.index].start },
      );
    }
    if (parts.length === 3 && parts[0] !== '' && !isDatabaseAllowed(parts[0], allowed)) {
      rejectDatabase(call, value, parts[0]);
    }
    const object = parts[parts.length - 1];
    if (!tempdbAllowed && object.startsWith('##')) rejectGlobalTemp(object, call.index);
  };

  const checkArgument = (call: Call, kind: DatabaseArgumentKind, range: [number, number], ordinal: string): void => {
    const [from, to] = range;
    switch (kind) {
      case 'name':
        checkNameString(call, literalArgument(call, range, ordinal, `Pass the name as a string literal, e.g. ${call.fn}('dbo.MyTable').`));
        return;
      case 'database': {
        const value = literalArgument(call, range, ordinal, `Pass the database name as a string literal, e.g. ${call.fn}('${options.allowedDatabases[0]}').`);
        if (!isDatabaseAllowed(value, allowed)) rejectDatabase(call, value, value, true);
        return;
      }
      case 'dbIdCall':
        if (!isCallTo(view, from, to, 'DB_ID')) {
          rejectUnverifiable(
            call,
            `the database id passed to ${call.fn} at ${at(call.index)} is not a DB_ID(...) call`,
            `Omit the database id to use the current database, or pass DB_ID('name').`,
          );
        }
        return;
    }
  };

  const ordinals = ['first', 'second'];

  tokens.forEach((token, index) => {
    const name = foldedName(view, index);
    if (name === null) return;
    const shown = token.kind === 'word' ? view.text(index) : token.value!.trim();

    const sysDatabases = name === 'DATABASES' && view.kind(index - 1) === 'dot' && foldedName(view, index - 2) === 'SYS';
    if (sysDatabases || SERVER_SCOPED_OBJECTS.has(name) || SERVER_SCOPED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      const object = sysDatabases ? 'sys.databases' : shown;
      reject(
        `Query rejected: "${object}" at ${at(index)} is not allowed: it shows data or metadata of every database on the server, including databases outside the list this server may access (${listed}). ${ALLOW_LIST_NOTE}`,
        ErrorType.PERMISSION_ERROR,
        { reason: 'server_scoped_object', object, position: token.start },
      );
    }

    if (!tempdbAllowed && shown.trimStart().startsWith('##')) rejectGlobalTemp(shown, index);

    if (!view.isSymbol(index + 1, '(')) return;
    const args = callArguments(view, index + 1);
    const call: Call = { fn: name, index };
    if (PERMISSION_FUNCTIONS.has(name)) {
      if (args.length === 0) return;
      // A NULL securable is the server itself, or the current database for the DATABASE
      // class; for the other classes SQL Server requires a name. FN_MY_PERMISSIONS reads
      // DEFAULT as NULL.
      const [securableFrom, securableTo] = args[0];
      const securable = securableTo - securableFrom === 1 ? view.exact(securableFrom) : null;
      if (securable === 'NULL' || (securable === 'DEFAULT' && name === 'FN_MY_PERMISSIONS')) return;
      const securableClass =
        args.length > 1 ? literalArgument(call, args[1], 'second', "Pass the securable class as a string literal, e.g. 'OBJECT'.") : 'OBJECT';
      checkArgument(call, foldName(securableClass) === 'DATABASE' ? 'database' : 'name', args[0], 'first');
      return;
    }
    const rule = DATABASE_ARGUMENT_FUNCTIONS.get(name);
    if (rule !== undefined && rule.index < args.length) checkArgument(call, rule.kind, args[rule.index], ordinals[rule.index]);
  });
}

/**
 * Rejects a 3-part name followed by "(", database.schema.function(...), whose database is
 * not on the allow-list. The name is read from the tokens, as checkNameChains reads it:
 * parts may be quoted with [ ] or " " (with "]]" or '""' as the escape) and separated by
 * whitespace or comments around the dots. An empty schema part (db..function) still names
 * database db; an empty database part means the current database. "$PARTITION" counts as
 * a name part, so database.$PARTITION.function(...) is checked too. Names with 4 or more
 * parts are rejected earlier by checkNameChains.
 */
function checkFunctionDatabases(view: TokenView, options: ReadOnlyQueryOptions): void {
  const { source, tokens } = view;
  const allowed = new Set(options.allowedDatabases);
  const isName = (index: number): boolean => view.kind(index) === 'word' || view.kind(index) === 'quotedIdentifier';
  const partAt = (index: number): string => (view.kind(index) === 'word' ? view.text(index) : tokens[index].value!);
  /** "$PARTITION" with nothing between "$" and the word, which SQL Server reads as one name. */
  const isPartitionName = (index: number): boolean =>
    view.isSymbol(index, '$') && view.exact(index + 1) === 'PARTITION' && tokens[index + 1].start === tokens[index].end;

  let index = 0;
  while (index < tokens.length) {
    if (!isName(index) && view.kind(index) !== 'dot') {
      index++;
      continue;
    }
    const parts: string[] = [];
    let part = '';
    let afterName = false;
    let end = index;
    for (; end < tokens.length; end++) {
      if (view.kind(end) === 'dot') {
        parts.push(part);
        part = '';
        afterName = false;
      } else if (isName(end) && !afterName) {
        part = partAt(end);
        afterName = true;
      } else if (isPartitionName(end) && !afterName && parts.length > 0) {
        part = 'PARTITION';
        afterName = true;
        end++;
      } else {
        break;
      }
    }
    parts.push(part);

    const database = parts[0];
    if (parts.length === 3 && view.isSymbol(end, '(') && database !== '' && !isDatabaseAllowed(database, allowed)) {
      const shown = source.slice(tokens[index].start, tokens[end - 1].end).replace(/\s+/g, ' ');
      reject(
        `Query rejected: "${shown}" at ${where(source, tokens[index].start)} is a 3-part name followed by "(", so it can call a function in database "${database}", which is not in the list of databases this server may access (${options.allowedDatabases.join(', ')}). Call only functions of those databases, or use 1- or 2-part names for the current database; methods called on a column as alias.column.method(...) are not supported.${spellingAdvice(database, allowed)} ${ALLOW_LIST_NOTE}`,
        ErrorType.PERMISSION_ERROR,
        { reason: 'database_not_allowed', database, name: shown, position: tokens[index].start, ...spellingDetails(database, allowed) },
      );
    }
    index = Math.max(end, index + 1);
  }
}

/** Throws MssqlMcpError if the query is not a single read-only SELECT; returns normally otherwise. */
export function validateReadOnlyQuery(query: string, options: ReadOnlyQueryOptions): void {
  if (typeof query !== 'string') {
    reject('Query rejected: the query must be a string.', ErrorType.VALIDATION_ERROR, { reason: 'invalid_query' });
  }

  const lexed = lex(query);
  const view = new TokenView(query, lexed.tokens);
  checkTokens(view);
  if (options.allowedDatabases.length > 0) checkFunctionDatabases(view, options);

  const rewrites = parserRewrites(view);
  const parserText = toParserText(query, lexed, rewrites);
  let ast: unknown;
  try {
    ast = parser.astify(parserText, PARSER_OPTIONS);
  } catch (error: unknown) {
    rejectParseError(error, parserText, unsupportedConstructs(view, rewrites));
  }

  // checkTokens only lets through a single statement, so any other count means that the
  // parser misread the query.
  const statements: unknown[] = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    rejectUnreadable(
      `the SQL validator's parser read the query as ${statements.length} statements, although it is a single statement`,
      unsupportedConstructs(view, rewrites),
      undefined,
      { statementCount: statements.length },
    );
  }
  const statementType = (statements[0] as { type?: unknown } | null)?.type;
  if (statementType !== 'select') {
    reject(
      `Query rejected: only SELECT queries are allowed, but the statement is of type "${String(statementType)}".`,
      ErrorType.VALIDATION_ERROR,
      { reason: 'not_select', statementType },
    );
  }

  checkAst(statements[0], options);
  if (options.allowedDatabases.length > 0) checkAllowListReach(view, options);
}
