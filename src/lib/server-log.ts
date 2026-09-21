// Lightweight server-side logging utility.
// Writes structured, timestamped, context-aware log lines to stdout/stderr.
// Guarantees secrets are redacted before anything reaches the log output.

type Level = 'info' | 'warn' | 'error';

// Common secret shapes we redact from any log line (token/API-key/credential
// patterns). This is a safety net, not a replacement for never logging secrets.
const SECRET_PATTERNS: RegExp[] = [
  /(sk-|pk-|rk-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35})[A-Za-z0-9_\-]*/g,
  /(?:\bBearer\s+)[A-Za-z0-9._~+\-/=]+/gi,
  /((?:password|passwd|secret|token|api[_-]?key|apikey|authorization|cookie)\s*[=:]\s*["']?)[A-Za-z0-9_\-./:@]{4,}/gi,
  /(\b(?:postgres|mysql|mongodb(\+srv)?|libsql|turso|http|https):\/\/[^\/\s]*):[^@\s]+@/gi,
];

export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '$1[REDACTED]');
  }
  return output;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, message: string, context?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const line = `[${redactSecrets(message)}]`;
  const ctx = context ? ' ' + redactSecrets(JSON.stringify(safeContext(context))) : '';
  const entry = `${timestamp} ${level.toUpperCase()} ${line}${ctx}`;
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

// Guard against non-serializable context values (cycles, undefined, functions).
function safeContext(context: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    if (typeof value === 'function') continue;
    try {
      JSON.stringify(value);
      safe[key] = value;
    } catch {
      safe[key] = typeof value;
    }
  }
  return safe;
}

export const logger = {
  info(message: string, context?: Record<string, unknown>): void {
    write('info', message, context);
  },
  warn(message: string, context?: Record<string, unknown>): void {
    write('warn', message, context);
  },
  error(message: string, error?: unknown, context?: Record<string, unknown>): void {
    const detail = error ? ': ' + stringify(error) : '';
    write('error', message + detail, context);
  },
};