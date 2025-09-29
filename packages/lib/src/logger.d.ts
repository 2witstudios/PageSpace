/**
 * PageSpace Structured Logger
 * Provides centralized logging with structured output, context injection, and performance tracking
 */
export declare enum LogLevel {
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
declare class Logger {
    private config;
    private buffer;
    private context;
    private flushTimer;
    private static instance;
    private startTime;
    private constructor();
    static getInstance(config?: Partial<LoggerConfig>): Logger;
    private parseLogLevel;
    private shouldLog;
    private formatLevel;
    private sanitizeData;
    private createLogEntry;
    private formatOutput;
    private getLevelColor;
    private dim;
    private red;
    private resetColor;
    private writeToConsole;
    private writeToDatabase;
    private flush;
    private startFlushTimer;
    private log;
    trace(message: string, metadata?: Record<string, any>): void;
    debug(message: string, metadata?: Record<string, any>): void;
    info(message: string, metadata?: Record<string, any>): void;
    warn(message: string, metadata?: Record<string, any>): void;
    error(message: string, error?: Error | Record<string, any>, metadata?: Record<string, any>): void;
    fatal(message: string, error?: Error | Record<string, any>, metadata?: Record<string, any>): void;
    setContext(context: LogContext): void;
    clearContext(): void;
    withContext(context: LogContext): Logger;
    startTimer(label: string): () => void;
    child(context: LogContext): Logger;
    setLevel(level: LogLevel | string): void;
    getLevel(): string;
    isLevelEnabled(level: LogLevel | string): boolean;
}
export declare const logger: Logger;
export type { Logger };
export default logger;
//# sourceMappingURL=logger.d.ts.map