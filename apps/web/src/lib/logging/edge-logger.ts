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
 * Output shape mirrors the existing logger's JSON so downstream parsing keeps
 * working: { timestamp, level, category, message, metadata? }. Level is
 * uppercase to match packages/lib/src/logging/logger.ts.
 *
 * MUST stay edge-safe: imports nothing (types only), no Node built-ins, no
 * process.on, no timers, no dynamic imports, no @pagespace/* imports.
 * `process.env` reads are supported in the Edge runtime and are the only
 * ambient state touched.
 */

/**
 * Security event names — keep in sync with logSecurityEvent's union in
 * packages/lib/src/logging/logger-config.ts. Duplicated (not imported) because
 * importing anything from @pagespace/lib would pull the Node-only logger into
 * the edge bundle; the token-prefixes re-export test pattern doesn't apply to
 * a pure type, and a drift here fails loudly at typecheck the moment a caller
 * uses a new event name.
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

export type EdgeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EdgeLogEntry {
  timestamp: string;
  level: string;
  category: string;
  message: string;
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
 * fatal → error, silent → suppress everything. Unknown values → info.
 * Read per-call, not at module load, so tests (and runtime reconfiguration)
 * see current env.
 */
function minimumLevel(): number {
  const raw = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  if (raw === 'silent') return Number.POSITIVE_INFINITY;
  if (raw === 'trace') return LEVEL_ORDER.debug;
  if (raw === 'fatal') return LEVEL_ORDER.error;
  return raw in LEVEL_ORDER ? LEVEL_ORDER[raw as EdgeLogLevel] : LEVEL_ORDER.info;
}

function emit(
  level: EdgeLogLevel,
  category: string,
  message: string,
  metadata?: EdgeLogMetadata
): void {
  if (LEVEL_ORDER[level] < minimumLevel()) return;

  const entry: EdgeLogEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    category,
    message,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    entry.metadata = metadata;
  }

  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Serialize an Error into plain metadata (Errors JSON.stringify to {}). */
function errorMetadata(error: Error | undefined, metadata?: EdgeLogMetadata): EdgeLogMetadata | undefined {
  if (!error) return metadata;
  return {
    ...metadata,
    error: { name: error.name, message: error.message, stack: error.stack },
  };
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
    error: (message, error, metadata) => emit('error', category, message, errorMetadata(error, metadata)),
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
