/**
 * Browser-Safe Logger
 * Provides logging functionality that works in both Node.js and browser environments
 * Excludes Node.js-specific APIs like process.memoryUsage() and os.hostname()
 */

import { createId } from '@paralleldrive/cuid2';

export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  FATAL = 5,
  SILENT = 6
}

export interface LogContext {
  userId?: string;
  sessionId?: string;
  requestId?: string;
  driveId?: string;
  pageId?: string;
  endpoint?: string;
  method?: string;
  ip?: string;
  userAgent?: string;
  duration?: number;
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  performance?: {
    duration: number;
    memory?: {
      used: number;
      total: number;
    };
  };
  metadata?: Record<string, any>;
  hostname?: string;
  pid?: number;
  version?: string;
}

export interface LoggerConfig {
  level: LogLevel;
  format: 'json' | 'text';
  enableContext: boolean;
  enablePerformance: boolean;
  version?: string;
  maxStringLength: number;
  maxObjectDepth: number;
  destination?: 'console' | 'none';
}

export class BrowserSafeLogger {
  private config: LoggerConfig;
  private context: LogContext = {};
  private startTime: number;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: LogLevel.INFO,
      format: 'text',
      enableContext: true,
      enablePerformance: false,
      maxStringLength: 1000,
      maxObjectDepth: 3,
      destination: 'console',
      ...config
    };
    this.startTime = Date.now();
  }

  private isNode(): boolean {
    return typeof process !== 'undefined' && process.versions?.node !== undefined;
  }

  private getHostname(): string {
    if (this.isNode()) {
      try {
        const { hostname } = require('os');
        return hostname();
      } catch {
        return 'unknown';
      }
    }
    return typeof window !== 'undefined' ? window.location.hostname : 'browser';
  }

  private getPid(): number | undefined {
    return this.isNode() ? process.pid : undefined;
  }

  private getMemoryUsage(): { used: number; total: number } | undefined {
    if (this.isNode()) {
      try {
        const memUsage = process.memoryUsage();
        return {
          used: Math.round(memUsage.heapUsed / 1024 / 1024),
          total: Math.round(memUsage.heapTotal / 1024 / 1024)
        };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private sanitizeData(data: any, depth = 0): any {
    if (depth > this.config.maxObjectDepth) {
      return '[Object: max depth exceeded]';
    }

    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === 'string') {
      return data.length > this.config.maxStringLength
        ? data.substring(0, this.config.maxStringLength) + '...[truncated]'
        : data;
    }

    if (typeof data === 'number' || typeof data === 'boolean') {
      return data;
    }

    if (data instanceof Error) {
      return {
        name: data.name,
        message: data.message,
        stack: data.stack
      };
    }

    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeData(item, depth + 1));
    }

    if (typeof data === 'object') {
      const sanitized: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        sanitized[key] = this.sanitizeData(value, depth + 1);
      }
      return sanitized;
    }

    return String(data);
  }

  private formatLevel(level: LogLevel): string {
    return LogLevel[level].toLowerCase();
  }

  private createLogEntry(
    level: LogLevel,
    message: string,
    metadata?: Record<string, any>,
    error?: Error
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: this.formatLevel(level),
      message
    };

    // Add environment-specific fields if available
    const hostname = this.getHostname();
    if (hostname) entry.hostname = hostname;

    const pid = this.getPid();
    if (pid) entry.pid = pid;

    if (this.config.version) entry.version = this.config.version;

    if (this.config.enableContext && Object.keys(this.context).length > 0) {
      entry.context = this.sanitizeData({ ...this.context });
    }

    if (metadata) {
      entry.metadata = this.sanitizeData(metadata);
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }

    if (this.config.enablePerformance) {
      const memory = this.getMemoryUsage();
      entry.performance = {
        duration: Date.now() - this.startTime
      };
      if (memory) {
        entry.performance.memory = memory;
      }
    }

    return entry;
  }

  private formatOutput(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify(entry);
    }

    let output = `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`;

    if (entry.context && Object.keys(entry.context).length > 0) {
      output += ` (${JSON.stringify(entry.context)})`;
    }

    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      output += ` ${JSON.stringify(entry.metadata)}`;
    }

    if (entry.error) {
      output += `\n  Error: ${entry.error.name}: ${entry.error.message}`;
      if (entry.error.stack) {
        output += `\n  Stack: ${entry.error.stack}`;
      }
    }

    return output;
  }

  private output(entry: LogEntry): void {
    if (this.config.destination === 'none') return;

    const formatted = this.formatOutput(entry);

    if (this.config.destination === 'console') {
      const level = entry.level.toLowerCase();
      if (level === 'error' || level === 'fatal') {
        console.error(formatted);
      } else if (level === 'warn') {
        console.warn(formatted);
      } else if (level === 'debug' || level === 'trace') {
        console.debug(formatted);
      } else {
        console.log(formatted);
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.config.level;
  }

  public setContext(context: Partial<LogContext>): void {
    this.context = { ...this.context, ...context };
  }

  public clearContext(): void {
    this.context = {};
  }

  public child(context: Partial<LogContext>): BrowserSafeLogger {
    const childLogger = new BrowserSafeLogger(this.config);
    childLogger.context = { ...this.context, ...context };
    return childLogger;
  }

  public trace(message: string, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.TRACE)) return;
    const entry = this.createLogEntry(LogLevel.TRACE, message, metadata);
    this.output(entry);
  }

  public debug(message: string, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;
    const entry = this.createLogEntry(LogLevel.DEBUG, message, metadata);
    this.output(entry);
  }

  public info(message: string, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.INFO)) return;
    const entry = this.createLogEntry(LogLevel.INFO, message, metadata);
    this.output(entry);
  }

  public warn(message: string, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.WARN)) return;
    const entry = this.createLogEntry(LogLevel.WARN, message, metadata);
    this.output(entry);
  }

  public error(message: string, errorOrMetadata?: Error | Record<string, any>, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;

    let error: Error | undefined;
    let meta: Record<string, any> | undefined;

    if (errorOrMetadata instanceof Error) {
      error = errorOrMetadata;
      meta = metadata;
    } else {
      error = undefined;
      meta = errorOrMetadata;
    }

    const entry = this.createLogEntry(LogLevel.ERROR, message, meta, error);
    this.output(entry);
  }

  public fatal(message: string, errorOrMetadata?: Error | Record<string, any>, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.FATAL)) return;

    let error: Error | undefined;
    let meta: Record<string, any> | undefined;

    if (errorOrMetadata instanceof Error) {
      error = errorOrMetadata;
      meta = metadata;
    } else {
      error = undefined;
      meta = errorOrMetadata;
    }

    const entry = this.createLogEntry(LogLevel.FATAL, message, meta, error);
    this.output(entry);
  }

  public log(level: LogLevel, message: string, metadata?: Record<string, any>, error?: Error): void {
    if (!this.shouldLog(level)) return;
    const entry = this.createLogEntry(level, message, metadata, error);
    this.output(entry);
  }
}

// Browser-safe logger instance
export const browserLogger = new BrowserSafeLogger({
  level: LogLevel.INFO,
  format: 'text',
  enableContext: true,
  enablePerformance: false
});

// Create browser-safe loggers for different modules
export const browserLoggers = {
  system: browserLogger.child({ module: 'system' }),
  auth: browserLogger.child({ module: 'auth' }),
  api: browserLogger.child({ module: 'api' }),
  db: browserLogger.child({ module: 'database' }),
  ai: browserLogger.child({ module: 'ai' }),
  realtime: browserLogger.child({ module: 'realtime' }),
  permissions: browserLogger.child({ module: 'permissions' }),
  monitoring: browserLogger.child({ module: 'monitoring' }),
  performance: browserLogger.child({ module: 'performance' })
};