type LogLevel = 'info' | 'warn' | 'error' | 'debug';

type LogMeta = Record<string, unknown> | undefined;

function write(level: LogLevel, message: string, meta?: LogMeta, error?: Error) {
  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    service: 'processor',
    level,
    message,
  };

  if (meta && Object.keys(meta).length > 0) {
    payload.meta = meta;
  }

  if (error) {
    payload.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  const line = JSON.stringify(payload, (_, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Map) {
      return Object.fromEntries(value);
    }
    if (typeof value === 'object' && value !== null) {
      return value;
    }
    return value;
  });

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const processorLogger = {
  info(message: string, meta?: LogMeta) {
    write('info', message, meta);
  },
  warn(message: string, meta?: LogMeta) {
    write('warn', message, meta);
  },
  debug(message: string, meta?: LogMeta) {
    write('debug', message, meta);
  },
  error(message: string, error: Error | null, meta?: LogMeta) {
    if (error instanceof Error) {
      write('error', message, meta, error);
    } else {
      write('error', message, meta);
    }
  },
};
