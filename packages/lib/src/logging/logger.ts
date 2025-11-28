/**
 * PageSpace Structured Logger
 * Provides centralized logging with structured output, context injection, and performance tracking
 */

import { hostname } from 'os';
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
  hostname: string;
  pid: number;
  version?: string;
}

export interface LoggerConfig {
  level: LogLevel;
  format: 'json' | 'pretty';
  destination: 'console' | 'database' | 'both';
  batchSize: number;
  flushInterval: number;
  enablePerformance: boolean;
  enableContext: boolean;
  sanitize: boolean;
  service: string;
  version?: string;
}

class Logger {
  private config: LoggerConfig;
  private buffer: LogEntry[] = [];
  private context: LogContext = {};
  private flushTimer: NodeJS.Timeout | null = null;
  private static instance: Logger;
  private startTime: number = Date.now();

  private constructor(config: Partial<LoggerConfig> = {}) {
    const configuredDestination = (process.env.LOG_DESTINATION || '').trim();
    const destination = (configuredDestination as 'console' | 'database' | 'both') ||
      (process.env.MONITORING_INGEST_KEY ? 'both' : 'console');

    this.config = {
      level: this.parseLogLevel(process.env.LOG_LEVEL || 'info'),
      format: (process.env.LOG_FORMAT as 'json' | 'pretty') ||
              (process.env.NODE_ENV === 'production' ? 'json' : 'pretty'),
      destination,
      batchSize: parseInt(process.env.LOG_BATCH_SIZE || '100'),
      flushInterval: parseInt(process.env.LOG_FLUSH_INTERVAL || '5000'),
      enablePerformance: process.env.LOG_PERFORMANCE !== 'false',
      enableContext: process.env.LOG_CONTEXT !== 'false',
      sanitize: process.env.LOG_SANITIZE !== 'false',
      service: 'pagespace',
      version: process.env.npm_package_version,
      ...config
    };

    this.startFlushTimer();
  }

  static getInstance(config?: Partial<LoggerConfig>): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(config);
    }
    return Logger.instance;
  }

  private parseLogLevel(level: string): LogLevel {
    const levels: Record<string, LogLevel> = {
      trace: LogLevel.TRACE,
      debug: LogLevel.DEBUG,
      info: LogLevel.INFO,
      warn: LogLevel.WARN,
      error: LogLevel.ERROR,
      fatal: LogLevel.FATAL,
      silent: LogLevel.SILENT
    };
    return levels[level.toLowerCase()] || LogLevel.INFO;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.config.level && this.config.level !== LogLevel.SILENT;
  }

  private formatLevel(level: LogLevel): string {
    const levels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'SILENT'];
    return levels[level] || 'INFO';
  }

  private sanitizeData(data: any): any {
    if (!this.config.sanitize) return data;
    
    const sensitive = [
      'password', 'token', 'secret', 'api_key', 'apiKey', 
      'authorization', 'cookie', 'credit_card', 'ssn', 'jwt'
    ];
    
    if (typeof data === 'string') {
      return data;
    }
    
    if (typeof data === 'object' && data !== null) {
      const sanitized: any = Array.isArray(data) ? [] : {};
      
      for (const key in data) {
        const lowerKey = key.toLowerCase();
        if (sensitive.some(s => lowerKey.includes(s))) {
          sanitized[key] = '[REDACTED]';
        } else if (typeof data[key] === 'object') {
          sanitized[key] = this.sanitizeData(data[key]);
        } else {
          sanitized[key] = data[key];
        }
      }
      
      return sanitized;
    }
    
    return data;
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
      message,
      hostname: hostname(),
      pid: process.pid,
      version: this.config.version
    };

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
      const memUsage = process.memoryUsage();
      entry.performance = {
        duration: Date.now() - this.startTime,
        memory: {
          used: Math.round(memUsage.heapUsed / 1024 / 1024),
          total: Math.round(memUsage.heapTotal / 1024 / 1024)
        }
      };
    }

    return entry;
  }

  private formatOutput(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify(entry);
    }

    // Pretty format for development
    const { timestamp, level, message, context, error, metadata } = entry;
    const time = new Date(timestamp).toLocaleTimeString();
    const levelColor = this.getLevelColor(level);
    
    let output = `${time} ${levelColor}[${level}]${this.resetColor()} ${message}`;
    
    if (context && Object.keys(context).length > 0) {
      output += ` ${this.dim()}${JSON.stringify(context)}${this.resetColor()}`;
    }
    
    if (metadata) {
      output += `\n  ${this.dim()}Metadata: ${JSON.stringify(metadata, null, 2)}${this.resetColor()}`;
    }
    
    if (error) {
      output += `\n  ${this.red()}Error: ${error.name}: ${error.message}${this.resetColor()}`;
      if (error.stack) {
        output += `\n  ${this.dim()}${error.stack}${this.resetColor()}`;
      }
    }
    
    return output;
  }

  private getLevelColor(level: string): string {
    if (process.env.NO_COLOR) return '';
    
    const colors: Record<string, string> = {
      TRACE: '\x1b[90m',  // Gray
      DEBUG: '\x1b[36m',  // Cyan
      INFO: '\x1b[32m',   // Green
      WARN: '\x1b[33m',   // Yellow
      ERROR: '\x1b[31m',  // Red
      FATAL: '\x1b[35m'   // Magenta
    };
    return colors[level] || '';
  }

  private dim(): string {
    return process.env.NO_COLOR ? '' : '\x1b[2m';
  }

  private red(): string {
    return process.env.NO_COLOR ? '' : '\x1b[31m';
  }

  private resetColor(): string {
    return process.env.NO_COLOR ? '' : '\x1b[0m';
  }

  private async writeToConsole(entry: LogEntry): Promise<void> {
    const output = this.formatOutput(entry);
    
    if (entry.level === 'ERROR' || entry.level === 'FATAL') {
      console.error(output);
    } else if (entry.level === 'WARN') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  private async writeToDatabase(entries: LogEntry[]): Promise<void> {
    // Dynamically import to avoid circular dependencies
    try {
      const { writeLogsToDatabase } = await import('./logger-database');
      await writeLogsToDatabase(entries);
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[Logger] Database writer not available:', error);
        console.log(`[Logger] Would write ${entries.length} entries to database`);
      }
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    const entriesToFlush = [...this.buffer];
    this.buffer = [];
    
    if (this.config.destination === 'database' || this.config.destination === 'both') {
      await this.writeToDatabase(entriesToFlush);
    }
    
    if (this.config.destination === 'console' || this.config.destination === 'both') {
      for (const entry of entriesToFlush) {
        await this.writeToConsole(entry);
      }
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    this.flushTimer = setInterval(() => {
      this.flush().catch(err => {
        console.error('[Logger] Flush error:', err);
      });
    }, this.config.flushInterval);
    
    // Ensure flush on process exit
    process.on('beforeExit', () => this.flush());
    process.on('SIGINT', () => {
      this.flush();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      this.flush();
      process.exit(0);
    });
  }

  private log(level: LogLevel, message: string, metadata?: Record<string, any>, error?: Error): void {
    if (!this.shouldLog(level)) return;
    
    const entry = this.createLogEntry(level, message, metadata, error);
    
    if (this.config.destination === 'console') {
      // Write immediately to console
      this.writeToConsole(entry).catch(err => {
        console.error('[Logger] Console write error:', err);
      });
    } else {
      // Buffer for batch writing
      this.buffer.push(entry);
      
      if (this.buffer.length >= this.config.batchSize) {
        this.flush().catch(err => {
          console.error('[Logger] Flush error:', err);
        });
      }
    }
  }

  // Public logging methods
  trace(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.TRACE, message, metadata);
  }

  debug(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, metadata);
  }

  info(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, metadata);
  }

  warn(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, metadata);
  }

  error(message: string, error?: Error | Record<string, any>, metadata?: Record<string, any>): void {
    if (error instanceof Error) {
      this.log(LogLevel.ERROR, message, metadata, error);
    } else {
      this.log(LogLevel.ERROR, message, { ...error, ...metadata });
    }
  }

  fatal(message: string, error?: Error | Record<string, any>, metadata?: Record<string, any>): void {
    if (error instanceof Error) {
      this.log(LogLevel.FATAL, message, metadata, error);
    } else {
      this.log(LogLevel.FATAL, message, { ...error, ...metadata });
    }
  }

  // Context management
  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  clearContext(): void {
    this.context = {};
  }

  withContext(context: LogContext): Logger {
    const childLogger = Object.create(this);
    childLogger.context = { ...this.context, ...context };
    return childLogger;
  }

  // Performance tracking
  startTimer(label: string): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.debug(`Timer [${label}]`, { duration, label });
      return duration;
    };
  }

  // Utility methods
  child(context: LogContext): Logger {
    return this.withContext(context);
  }

  setLevel(level: LogLevel | string): void {
    this.config.level = typeof level === 'string' ? this.parseLogLevel(level) : level;
  }

  getLevel(): string {
    return this.formatLevel(this.config.level);
  }

  isLevelEnabled(level: LogLevel | string): boolean {
    const checkLevel = typeof level === 'string' ? this.parseLogLevel(level) : level;
    return this.shouldLog(checkLevel);
  }
}

// Export singleton instance
export const logger = Logger.getInstance();

// Export for type usage
export type { Logger };