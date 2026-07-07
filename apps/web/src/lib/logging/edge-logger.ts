/**
 * Edge-safe structured logger.
 *
 * The Edge runtime middleware (and any module in its import graph) cannot use
 * @pagespace/lib's logger: that logger reads os.hostname(), registers
 * process.on() exit handlers, runs a setInterval flush loop, and dynamically
 * imports the database writer — all Node-only. This module is the middleware's
 * logging surface instead: synchronous structured JSON to the console, which
 * Fly log drains ingest the same way they ingest the Node logger's output.
 *
 * Output shape: { timestamp, level, category, message, context, metadata? }.
 * Level is uppercase and `context.category` is set to match the Node logger's
 * console JSON (packages/lib/src/logging/logger.ts nests category there), so
 * drain queries keyed on either `category` or `context.category` match lines
 * from both runtimes. Known, accepted divergences from the Node logger: no
 * hostname/pid (no `os` on edge), no SIEM error-hook fan-out (middleware
 * errors reach the Node layer via the monitoring ingest POST instead), and
 * response-log fields sit flat under `metadata` rather than
 * `metadata.context`.
 *
 * Sensitive-key redaction mirrors the Node logger's sanitizer (same
 * substring/exact lists) so a metadata field like `token` or `email` never
 * reaches the log stream verbatim from either runtime.
 *
 * MUST stay edge-safe: imports nothing, no Node built-ins, no process.on, no
 * timers, no dynamic imports, no @pagespace/* imports. `process.env` reads
 * are supported in the Edge runtime and are the only ambient state touched.
 */

/**
 * Security event names — keep in sync with logSecurityEvent's parameter union
 * in packages/lib/src/logging/logger-config.ts. Duplicated (not imported)
 * because this module must not import from @pagespace/lib, and the Node-side
 * union is an anonymous parameter type. Drift is caught by the sync test in
 * __tests__/edge-logger.test.ts, which parses both unions from source.
 */
export type SecurityEventName =
  | 'rate_limit' | 'invalid_token' | 'unauthorized' | 'suspicious_activity'
  | 'login_csrf_missing' | 'login_csrf_mismatch' | 'login_csrf_invalid'
  | 'signup_csrf_missing' | 'signup_csrf_mismatch' | 'signup_csrf_invalid'
  | 'origin_validation_failed' | 'origin_validation_warning'
  | 'account_locked_login_attempt' | 'admin_role_version_mismatch'
  | 'magic_link_csrf_missing' | 'magic_link_csrf_mismatch' | 'magic_link_csrf_invalid'
  | 'magic_link_rate_limit_ip' | 'magic_link_rate_limit_email' | 'magic_link_suspended_user'
  | 'passkey_csrf_invalid' | 'passkey_rate_limit_auth' | 'passkey_rate_limit_options' | 'passkey_rate_limit_register'
  | 'passkey_rate_limit_signup_ip' | 'passkey_rate_limit_signup_email'
  | 'signup_blocked_onprem';

export type EdgeLogMetadata = Record<string, unknown>;

type EdgeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EdgeLogEntry {
  timestamp: string;
  level: string;
  category: string;
  message: string;
  /** Mirrors the Node logger's `context.category` nesting for drain parity. */
  context: { category: string };
  metadata?: EdgeLogMetadata;
}

const LEVEL_ORDER: Record<EdgeLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Minimum level to emit, from LOG_LEVEL (same env var the Node logger reads).
 * The Node logger's extra levels map onto this module's four: trace → debug,
 * fatal → error, silent → suppress everything. Unknown values → info (the
 * Node logger's default too). Read per-call, not at module load, so tests
 * (and runtime reconfiguration) see current env.
 */
function minimumLevel(): number {
  const raw = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  if (raw === 'silent') return Number.POSITIVE_INFINITY;
  if (raw === 'trace') return LEVEL_ORDER.debug;
  if (raw === 'fatal') return LEVEL_ORDER.error;
  return Object.hasOwn(LEVEL_ORDER, raw) ? LEVEL_ORDER[raw as EdgeLogLevel] : LEVEL_ORDER.info;
}

// Sensitive-key redaction — same two-tier matching as the Node logger's
// sanitizeData (packages/lib/src/logging/logger.ts): substrings that always
// mean credentials, exact names that mean PII. Keep the lists aligned.
const SUBSTRING_SENSITIVE = [
  'password', 'token', 'secret', 'api_key', 'apikey',
  'authorization', 'cookie', 'credit_card', 'jwt',
];
const EXACT_SENSITIVE = new Set([
  'ssn',
  'email', 'emailaddress',
  'phone', 'phonenumber', 'mobilenumber',
  'address', 'streetaddress', 'homeaddress', 'mailingaddress',
  'dob', 'dateofbirth', 'birthdate',
  'name', 'firstname', 'lastname', 'fullname', 'displayname',
  'username', 'filename', 'originalname',
]);

const MAX_SANITIZE_DEPTH = 6;

/**
 * Redact sensitive keys, depth-limited. The depth cap doubles as circular-
 * reference protection: a cycle bottoms out as '[depth_limited]' instead of
 * recursing forever (and instead of JSON.stringify throwing later).
 */
function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return '[depth_limited]';
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const lower = key.toLowerCase();
      if (SUBSTRING_SENSITIVE.some((s) => lower.includes(s)) || EXACT_SENSITIVE.has(lower)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeMetadata(source[key], depth + 1);
      }
    }
    return sanitized;
  }
  return value;
}

function emit(
  level: EdgeLogLevel,
  category: string,
  message: string,
  metadata?: EdgeLogMetadata,
  error?: Error
): void {
  if (LEVEL_ORDER[level] < minimumLevel()) return;

  const entry: EdgeLogEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    category,
    message,
    context: { category },
  };
  if (metadata && Object.keys(metadata).length > 0) {
    entry.metadata = sanitizeMetadata(metadata) as EdgeLogMetadata;
  }
  if (error) {
    // Attached after sanitization on purpose: `name` is on the exact-match
    // redaction list, but error.name here is a constructed, safe field.
    entry.metadata = {
      ...entry.metadata,
      error: { name: error.name, message: error.message, stack: error.stack },
    };
  }

  // A logger must never throw into its caller: metadata can still contain
  // non-serializable values (BigInt), so fall back to a metadata-free line.
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ ...entry, metadata: { serialization: 'failed' } });
  }

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export interface EdgeLogger {
  debug(message: string, metadata?: EdgeLogMetadata): void;
  info(message: string, metadata?: EdgeLogMetadata): void;
  warn(message: string, metadata?: EdgeLogMetadata): void;
  error(message: string, error?: Error, metadata?: EdgeLogMetadata): void;
}

/**
 * Category-scoped logger, mirroring `loggers.<category>` from
 * packages/lib logger-config (auth, api, system, performance, security, …).
 */
export function createEdgeLogger(category: string): EdgeLogger {
  return {
    debug: (message, metadata) => emit('debug', category, message, metadata),
    info: (message, metadata) => emit('info', category, message, metadata),
    warn: (message, metadata) => emit('warn', category, message, metadata),
    error: (message, error, metadata) => emit('error', category, message, metadata, error),
  };
}

/**
 * Edge counterpart of packages/lib logSecurityEvent: same event-name union,
 * same message format and warn level, so security-event queries over the log
 * stream match rows from either runtime.
 */
export function logSecurityEvent(event: SecurityEventName, details: EdgeLogMetadata): void {
  emit('warn', 'security', `Security event: ${event}`, details);
}
