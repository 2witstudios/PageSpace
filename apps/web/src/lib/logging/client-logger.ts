export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface ClientLoggerOptions {
  namespace: string;
  component?: string;
}

const LEVEL_ORDER: Record<ClientLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(level: string | undefined): ClientLogLevel {
  if (!level) {
    return process.env.NODE_ENV === 'production' ? 'warn' : 'debug';
  }

  const normalized = level.toLowerCase() as ClientLogLevel;
  if (normalized in LEVEL_ORDER) {
    return normalized;
  }

  return process.env.NODE_ENV === 'production' ? 'warn' : 'debug';
}

const configuredLevel = normalizeLevel(process.env.NEXT_PUBLIC_CLIENT_LOG_LEVEL);
const debugEnabled =
  configuredLevel === 'debug' || process.env.NEXT_PUBLIC_CLIENT_DEBUG === 'true';

function shouldLog(level: ClientLogLevel): boolean {
  if (level === 'debug' && !debugEnabled) {
    return false;
  }

  return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel];
}

function sanitizeMetadata(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeMetadata);
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeMetadata(entry);
    }
    return result;
  }

  return value;
}

function getConsoleMethod(level: ClientLogLevel): typeof console.log {
  switch (level) {
    case 'debug':
      return console.debug.bind(console);
    case 'info':
      return console.info.bind(console);
    case 'warn':
      return console.warn.bind(console);
    case 'error':
      return console.error.bind(console);
    default:
      return console.log.bind(console);
  }
}

export interface ClientLogger {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
}

function log(
  level: ClientLogLevel,
  options: ClientLoggerOptions,
  message: string,
  metadata?: Record<string, unknown>
): void {
  if (!shouldLog(level)) {
    return;
  }

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    namespace: options.namespace,
    message,
  };

  if (options.component) {
    entry.component = options.component;
  }

  if (metadata && Object.keys(metadata).length > 0) {
    entry.metadata = sanitizeMetadata(metadata);
  }

  const consoleMethod = getConsoleMethod(level);
  consoleMethod(entry);
}

export function createClientLogger(options: ClientLoggerOptions): ClientLogger {
  return {
    debug: (message, metadata) => log('debug', options, message, metadata),
    info: (message, metadata) => log('info', options, message, metadata),
    warn: (message, metadata) => log('warn', options, message, metadata),
    error: (message, metadata) => log('error', options, message, metadata),
  };
}
