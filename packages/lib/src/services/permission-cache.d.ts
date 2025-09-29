export interface PermissionLevel {
    canView: boolean;
    canEdit: boolean;
    canShare: boolean;
    canDelete: boolean;
}
export interface CachedPermission extends PermissionLevel {
    userId: string;
    pageId: string;
    driveId: string;
    isOwner: boolean;
    cachedAt: number;
    ttl: number;
}
export interface DriveAccess {
    userId: string;
    driveId: string;
    hasAccess: boolean;
    isOwner: boolean;
    cachedAt: number;
    ttl: number;
}
interface CacheConfig {
    defaultTTL: number;
    maxMemoryEntries: number;
    enableRedis: boolean;
    keyPrefix: string;
}
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
export declare class PermissionCache {
    private static instance;
    private redis;
    private memoryCache;
    private config;
    private isRedisAvailable;
    private constructor();
    /**
     * Get singleton instance
     */
    static getInstance(config?: Partial<CacheConfig>): PermissionCache;
    /**
     * Initialize Redis connection with graceful fallback
     */
    private initializeRedis;
    /**
     * Cleanup expired entries from memory cache
     */
    private startMemoryCacheCleanup;
    /**
     * Generate cache key for page permissions
     */
    private getPagePermissionKey;
    /**
     * Generate cache key for drive access
     */
    private getDriveAccessKey;
    /**
     * Get permission from cache (L1 memory -> L2 Redis)
     */
    getPagePermission(userId: string, pageId: string): Promise<CachedPermission | null>;
    /**
     * Set permission in cache (L1 + L2)
     */
    setPagePermission(userId: string, pageId: string, driveId: string, permission: PermissionLevel, isOwner: boolean, ttl?: number): Promise<void>;
    /**
     * Get drive access from cache
     */
    getDriveAccess(userId: string, driveId: string): Promise<DriveAccess | null>;
    /**
     * Set drive access in cache
     */
    setDriveAccess(userId: string, driveId: string, hasAccess: boolean, isOwner: boolean, ttl?: number): Promise<void>;
    /**
     * Batch get permissions for multiple pages
     */
    getBatchPagePermissions(userId: string, pageIds: string[]): Promise<Map<string, CachedPermission>>;
    /**
     * Invalidate cache entries for a user
     */
    invalidateUserCache(userId: string): Promise<void>;
    /**
     * Invalidate cache entries for a drive
     */
    invalidateDriveCache(driveId: string): Promise<void>;
    /**
     * Get cache statistics
     */
    getCacheStats(): {
        memoryEntries: number;
        redisAvailable: boolean;
        maxMemoryEntries: number;
        memoryUsagePercent: number;
    };
    /**
     * Clear all cache entries (use with caution)
     */
    clearAll(): Promise<void>;
    /**
     * Graceful shutdown
     */
    shutdown(): Promise<void>;
}
export declare const permissionCache: PermissionCache;
export {};
//# sourceMappingURL=permission-cache.d.ts.map