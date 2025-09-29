"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.permissionCache = exports.PermissionCache = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_config_1 = require("../logger-config");
/**
 * High-performance permission caching service with hybrid in-memory + Redis architecture
 *
 * Features:
 * - Two-tier caching: in-memory (L1) + Redis (L2)
 * - Batch operations for N+1 query elimination
 * - Automatic TTL and cache invalidation
 * - Graceful degradation when Redis is unavailable
 * - Production-ready error handling and monitoring
 */
class PermissionCache {
    static instance = null;
    redis = null;
    memoryCache = new Map();
    config;
    isRedisAvailable = false;
    constructor(config = {}) {
        this.config = {
            defaultTTL: 60, // 1 minute default TTL
            maxMemoryEntries: 1000, // Limit memory cache size
            enableRedis: true,
            keyPrefix: 'pagespace:perms:',
            ...config
        };
        this.initializeRedis();
        this.startMemoryCacheCleanup();
    }
    /**
     * Get singleton instance
     */
    static getInstance(config) {
        if (!PermissionCache.instance) {
            PermissionCache.instance = new PermissionCache(config);
        }
        return PermissionCache.instance;
    }
    /**
     * Initialize Redis connection with graceful fallback
     */
    async initializeRedis() {
        if (!this.config.enableRedis)
            return;
        try {
            const redisUrl = process.env.REDIS_URL;
            if (!redisUrl) {
                logger_config_1.loggers.api.warn('REDIS_URL not configured, using memory-only cache');
                return;
            }
            this.redis = new ioredis_1.default(redisUrl, {
                maxRetriesPerRequest: 3,
                lazyConnect: true,
                connectTimeout: 5000,
                commandTimeout: 3000,
            });
            this.redis.on('connect', () => {
                this.isRedisAvailable = true;
                logger_config_1.loggers.api.info('Redis connected for permission caching');
            });
            this.redis.on('error', (error) => {
                this.isRedisAvailable = false;
                logger_config_1.loggers.api.warn('Redis connection error, falling back to memory cache', error);
            });
            this.redis.on('close', () => {
                this.isRedisAvailable = false;
                logger_config_1.loggers.api.warn('Redis connection closed, using memory cache only');
            });
            // Test connection
            await this.redis.ping();
            this.isRedisAvailable = true;
        }
        catch (error) {
            logger_config_1.loggers.api.warn('Failed to initialize Redis, using memory-only cache', {
                error: error instanceof Error ? error.message : String(error)
            });
            this.redis = null;
            this.isRedisAvailable = false;
        }
    }
    /**
     * Cleanup expired entries from memory cache
     */
    startMemoryCacheCleanup() {
        setInterval(() => {
            const now = Date.now();
            let cleanedCount = 0;
            for (const [key, entry] of this.memoryCache.entries()) {
                if (now > entry.cachedAt + (entry.ttl * 1000)) {
                    this.memoryCache.delete(key);
                    cleanedCount++;
                }
            }
            // Also enforce size limit
            if (this.memoryCache.size > this.config.maxMemoryEntries) {
                const excess = this.memoryCache.size - this.config.maxMemoryEntries;
                const keysToDelete = Array.from(this.memoryCache.keys()).slice(0, excess);
                keysToDelete.forEach(key => this.memoryCache.delete(key));
                cleanedCount += keysToDelete.length;
            }
            if (cleanedCount > 0) {
                logger_config_1.loggers.api.debug(`Cleaned ${cleanedCount} expired permission cache entries`);
            }
        }, 30000); // Clean every 30 seconds
    }
    /**
     * Generate cache key for page permissions
     */
    getPagePermissionKey(userId, pageId) {
        return `${this.config.keyPrefix}page:${userId}:${pageId}`;
    }
    /**
     * Generate cache key for drive access
     */
    getDriveAccessKey(userId, driveId) {
        return `${this.config.keyPrefix}drive:${userId}:${driveId}`;
    }
    /**
     * Get permission from cache (L1 memory -> L2 Redis)
     */
    async getPagePermission(userId, pageId) {
        const key = this.getPagePermissionKey(userId, pageId);
        // L1: Check memory cache first
        const memoryResult = this.memoryCache.get(key);
        if (memoryResult && Date.now() < memoryResult.cachedAt + (memoryResult.ttl * 1000)) {
            return memoryResult;
        }
        // L2: Check Redis cache
        if (this.isRedisAvailable && this.redis) {
            try {
                const redisResult = await this.redis.get(key);
                if (redisResult) {
                    const parsed = JSON.parse(redisResult);
                    // Promote to L1 cache
                    this.memoryCache.set(key, parsed);
                    return parsed;
                }
            }
            catch (error) {
                logger_config_1.loggers.api.warn('Redis get error, using memory cache only', { key, error });
            }
        }
        return null;
    }
    /**
     * Set permission in cache (L1 + L2)
     */
    async setPagePermission(userId, pageId, driveId, permission, isOwner, ttl = this.config.defaultTTL) {
        const key = this.getPagePermissionKey(userId, pageId);
        const cached = {
            ...permission,
            userId,
            pageId,
            driveId,
            isOwner,
            cachedAt: Date.now(),
            ttl
        };
        // Store in L1 (memory)
        this.memoryCache.set(key, cached);
        // Store in L2 (Redis)
        if (this.isRedisAvailable && this.redis) {
            try {
                await this.redis.setex(key, ttl, JSON.stringify(cached));
            }
            catch (error) {
                logger_config_1.loggers.api.warn('Redis set error, continuing with memory cache', { key, error });
            }
        }
    }
    /**
     * Get drive access from cache
     */
    async getDriveAccess(userId, driveId) {
        const key = this.getDriveAccessKey(userId, driveId);
        // L1: Check memory cache first
        const memoryResult = this.memoryCache.get(key);
        if (memoryResult && Date.now() < memoryResult.cachedAt + (memoryResult.ttl * 1000)) {
            return memoryResult;
        }
        // L2: Check Redis cache
        if (this.isRedisAvailable && this.redis) {
            try {
                const redisResult = await this.redis.get(key);
                if (redisResult) {
                    const parsed = JSON.parse(redisResult);
                    // Promote to L1 cache
                    this.memoryCache.set(key, parsed);
                    return parsed;
                }
            }
            catch (error) {
                logger_config_1.loggers.api.warn('Redis get error for drive access', { key, error });
            }
        }
        return null;
    }
    /**
     * Set drive access in cache
     */
    async setDriveAccess(userId, driveId, hasAccess, isOwner, ttl = this.config.defaultTTL) {
        const key = this.getDriveAccessKey(userId, driveId);
        const cached = {
            userId,
            driveId,
            hasAccess,
            isOwner,
            cachedAt: Date.now(),
            ttl
        };
        // Store in L1 (memory)
        this.memoryCache.set(key, cached);
        // Store in L2 (Redis)
        if (this.isRedisAvailable && this.redis) {
            try {
                await this.redis.setex(key, ttl, JSON.stringify(cached));
            }
            catch (error) {
                logger_config_1.loggers.api.warn('Redis set error for drive access', { key, error });
            }
        }
    }
    /**
     * Batch get permissions for multiple pages
     */
    async getBatchPagePermissions(userId, pageIds) {
        const results = new Map();
        const uncachedPageIds = [];
        // Check L1 cache for all pageIds
        for (const pageId of pageIds) {
            const key = this.getPagePermissionKey(userId, pageId);
            const cached = this.memoryCache.get(key);
            if (cached && Date.now() < cached.cachedAt + (cached.ttl * 1000)) {
                results.set(pageId, cached);
            }
            else {
                uncachedPageIds.push(pageId);
            }
        }
        // Check L2 cache (Redis) for uncached items
        if (uncachedPageIds.length > 0 && this.isRedisAvailable && this.redis) {
            try {
                const keys = uncachedPageIds.map(pageId => this.getPagePermissionKey(userId, pageId));
                const redisResults = await this.redis.mget(...keys);
                for (let i = 0; i < redisResults.length; i++) {
                    const result = redisResults[i];
                    if (result) {
                        const parsed = JSON.parse(result);
                        results.set(uncachedPageIds[i], parsed);
                        // Promote to L1
                        this.memoryCache.set(keys[i], parsed);
                    }
                }
            }
            catch (error) {
                logger_config_1.loggers.api.warn('Redis mget error for batch permissions', { error });
            }
        }
        return results;
    }
    /**
     * Invalidate cache entries for a user
     */
    async invalidateUserCache(userId) {
        // Clear from memory cache
        const keysToDelete = [];
        for (const [key, entry] of this.memoryCache.entries()) {
            if (entry.userId === userId) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => this.memoryCache.delete(key));
        // Clear from Redis cache
        if (this.isRedisAvailable && this.redis) {
            try {
                const pattern = `${this.config.keyPrefix}*:${userId}:*`;
                const keys = await this.redis.keys(pattern);
                if (keys.length > 0) {
                    await this.redis.del(...keys);
                }
            }
            catch (error) {
                logger_config_1.loggers.api.warn('Redis invalidation error', { userId, error });
            }
        }
        logger_config_1.loggers.api.debug(`Invalidated permission cache for user ${userId}`);
    }
    /**
     * Invalidate cache entries for a drive
     */
    async invalidateDriveCache(driveId) {
        // Clear from memory cache
        const keysToDelete = [];
        for (const [key, entry] of this.memoryCache.entries()) {
            if ('driveId' in entry && entry.driveId === driveId) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => this.memoryCache.delete(key));
        // Clear from Redis cache
        if (this.isRedisAvailable && this.redis) {
            try {
                const patterns = [
                    `${this.config.keyPrefix}page:*:*`, // Will need to filter by driveId
                    `${this.config.keyPrefix}drive:*:${driveId}`
                ];
                for (const pattern of patterns) {
                    const keys = await this.redis.keys(pattern);
                    if (keys.length > 0) {
                        // For page permissions, we need to check driveId in the value
                        if (pattern.includes('page:')) {
                            const values = await this.redis.mget(...keys);
                            const keysToDelete = keys.filter((key, index) => {
                                const value = values[index];
                                if (value) {
                                    try {
                                        const parsed = JSON.parse(value);
                                        return parsed.driveId === driveId;
                                    }
                                    catch {
                                        return false;
                                    }
                                }
                                return false;
                            });
                            if (keysToDelete.length > 0) {
                                await this.redis.del(...keysToDelete);
                            }
                        }
                        else {
                            await this.redis.del(...keys);
                        }
                    }
                }
            }
            catch (error) {
                logger_config_1.loggers.api.warn('Redis drive invalidation error', { driveId, error });
            }
        }
        logger_config_1.loggers.api.debug(`Invalidated permission cache for drive ${driveId}`);
    }
    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            memoryEntries: this.memoryCache.size,
            redisAvailable: this.isRedisAvailable,
            maxMemoryEntries: this.config.maxMemoryEntries,
            memoryUsagePercent: Math.round((this.memoryCache.size / this.config.maxMemoryEntries) * 100)
        };
    }
    /**
     * Clear all cache entries (use with caution)
     */
    async clearAll() {
        this.memoryCache.clear();
        if (this.isRedisAvailable && this.redis) {
            try {
                const keys = await this.redis.keys(`${this.config.keyPrefix}*`);
                if (keys.length > 0) {
                    await this.redis.del(...keys);
                }
            }
            catch (error) {
                logger_config_1.loggers.api.warn('Redis clear all error', { error });
            }
        }
        logger_config_1.loggers.api.info('Cleared all permission cache entries');
    }
    /**
     * Graceful shutdown
     */
    async shutdown() {
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
        this.memoryCache.clear();
        PermissionCache.instance = null;
    }
}
exports.PermissionCache = PermissionCache;
// Export singleton instance
exports.permissionCache = PermissionCache.getInstance();
