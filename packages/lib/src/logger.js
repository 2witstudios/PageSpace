"use strict";
/**
 * PageSpace Structured Logger
 * Provides centralized logging with structured output, context injection, and performance tracking
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.LogLevel = void 0;
const os_1 = require("os");
var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["TRACE"] = 0] = "TRACE";
    LogLevel[LogLevel["DEBUG"] = 1] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 2] = "INFO";
    LogLevel[LogLevel["WARN"] = 3] = "WARN";
    LogLevel[LogLevel["ERROR"] = 4] = "ERROR";
    LogLevel[LogLevel["FATAL"] = 5] = "FATAL";
    LogLevel[LogLevel["SILENT"] = 6] = "SILENT";
})(LogLevel || (exports.LogLevel = LogLevel = {}));
class Logger {
    config;
    buffer = [];
    context = {};
    flushTimer = null;
    static instance;
    startTime = Date.now();
    constructor(config = {}) {
        const configuredDestination = (process.env.LOG_DESTINATION || '').trim();
        const destination = configuredDestination ||
            (process.env.MONITORING_INGEST_KEY ? 'both' : 'console');
        this.config = {
            level: this.parseLogLevel(process.env.LOG_LEVEL || 'info'),
            format: process.env.LOG_FORMAT ||
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
    static getInstance(config) {
        if (!Logger.instance) {
            Logger.instance = new Logger(config);
        }
        return Logger.instance;
    }
    parseLogLevel(level) {
        const levels = {
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
    shouldLog(level) {
        return level >= this.config.level && this.config.level !== LogLevel.SILENT;
    }
    formatLevel(level) {
        const levels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'SILENT'];
        return levels[level] || 'INFO';
    }
    sanitizeData(data) {
        if (!this.config.sanitize)
            return data;
        const sensitive = [
            'password', 'token', 'secret', 'api_key', 'apiKey',
            'authorization', 'cookie', 'credit_card', 'ssn', 'jwt'
        ];
        if (typeof data === 'string') {
            return data;
        }
        if (typeof data === 'object' && data !== null) {
            const sanitized = Array.isArray(data) ? [] : {};
            for (const key in data) {
                const lowerKey = key.toLowerCase();
                if (sensitive.some(s => lowerKey.includes(s))) {
                    sanitized[key] = '[REDACTED]';
                }
                else if (typeof data[key] === 'object') {
                    sanitized[key] = this.sanitizeData(data[key]);
                }
                else {
                    sanitized[key] = data[key];
                }
            }
            return sanitized;
        }
        return data;
    }
    createLogEntry(level, message, metadata, error) {
        const entry = {
            timestamp: new Date().toISOString(),
            level: this.formatLevel(level),
            message,
            hostname: (0, os_1.hostname)(),
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
    formatOutput(entry) {
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
    getLevelColor(level) {
        if (process.env.NO_COLOR)
            return '';
        const colors = {
            TRACE: '\x1b[90m', // Gray
            DEBUG: '\x1b[36m', // Cyan
            INFO: '\x1b[32m', // Green
            WARN: '\x1b[33m', // Yellow
            ERROR: '\x1b[31m', // Red
            FATAL: '\x1b[35m' // Magenta
        };
        return colors[level] || '';
    }
    dim() {
        return process.env.NO_COLOR ? '' : '\x1b[2m';
    }
    red() {
        return process.env.NO_COLOR ? '' : '\x1b[31m';
    }
    resetColor() {
        return process.env.NO_COLOR ? '' : '\x1b[0m';
    }
    async writeToConsole(entry) {
        const output = this.formatOutput(entry);
        if (entry.level === 'ERROR' || entry.level === 'FATAL') {
            console.error(output);
        }
        else if (entry.level === 'WARN') {
            console.warn(output);
        }
        else {
            console.log(output);
        }
    }
    async writeToDatabase(entries) {
        // Dynamically import to avoid circular dependencies
        try {
            const { writeLogsToDatabase } = await Promise.resolve().then(() => __importStar(require('./logger-database')));
            await writeLogsToDatabase(entries);
        }
        catch (error) {
            if (process.env.NODE_ENV === 'development') {
                console.error('[Logger] Database writer not available:', error);
                console.log(`[Logger] Would write ${entries.length} entries to database`);
            }
        }
    }
    async flush() {
        if (this.buffer.length === 0)
            return;
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
    startFlushTimer() {
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
    log(level, message, metadata, error) {
        if (!this.shouldLog(level))
            return;
        const entry = this.createLogEntry(level, message, metadata, error);
        if (this.config.destination === 'console') {
            // Write immediately to console
            this.writeToConsole(entry).catch(err => {
                console.error('[Logger] Console write error:', err);
            });
        }
        else {
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
    trace(message, metadata) {
        this.log(LogLevel.TRACE, message, metadata);
    }
    debug(message, metadata) {
        this.log(LogLevel.DEBUG, message, metadata);
    }
    info(message, metadata) {
        this.log(LogLevel.INFO, message, metadata);
    }
    warn(message, metadata) {
        this.log(LogLevel.WARN, message, metadata);
    }
    error(message, error, metadata) {
        if (error instanceof Error) {
            this.log(LogLevel.ERROR, message, metadata, error);
        }
        else {
            this.log(LogLevel.ERROR, message, { ...error, ...metadata });
        }
    }
    fatal(message, error, metadata) {
        if (error instanceof Error) {
            this.log(LogLevel.FATAL, message, metadata, error);
        }
        else {
            this.log(LogLevel.FATAL, message, { ...error, ...metadata });
        }
    }
    // Context management
    setContext(context) {
        this.context = { ...this.context, ...context };
    }
    clearContext() {
        this.context = {};
    }
    withContext(context) {
        const childLogger = Object.create(this);
        childLogger.context = { ...this.context, ...context };
        return childLogger;
    }
    // Performance tracking
    startTimer(label) {
        const start = Date.now();
        return () => {
            const duration = Date.now() - start;
            this.debug(`Timer [${label}]`, { duration, label });
            return duration;
        };
    }
    // Utility methods
    child(context) {
        return this.withContext(context);
    }
    setLevel(level) {
        this.config.level = typeof level === 'string' ? this.parseLogLevel(level) : level;
    }
    getLevel() {
        return this.formatLevel(this.config.level);
    }
    isLevelEnabled(level) {
        const checkLevel = typeof level === 'string' ? this.parseLogLevel(level) : level;
        return this.shouldLog(checkLevel);
    }
}
// Export singleton instance
exports.logger = Logger.getInstance();
// Convenience exports
exports.default = exports.logger;
