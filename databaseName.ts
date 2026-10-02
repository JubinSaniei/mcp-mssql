/**
 * Returns a database name without its delimiters: surrounding whitespace is trimmed, one layer
 * of `[...]` or `"..."` is removed (decoding `]]` or `""` inside it), and the result is trimmed.
 * Undelimited names are only trimmed.
 */
export function normalizeDatabaseName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).replace(/\]\]/g, ']').trim();
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"').trim();
  }
  return trimmed;
}

/** The case-insensitive comparison key for a database name. */
export function databaseNameKey(name: string): string {
  return normalizeDatabaseName(name).toLowerCase();
}
