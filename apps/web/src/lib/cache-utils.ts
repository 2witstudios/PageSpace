/**
 * Cache utilities for PageSpace application
 * Implements LRU cache and view state management
 */

export interface CacheItem<T> {
  key: string;
  value: T;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
}

export interface CacheOptions {
  maxSize: number;
  maxAge?: number; // in milliseconds
  onEvict?: (key: string, value: unknown) => void;
}

/**
 * Least Recently Used (LRU) Cache implementation
 */
export class LRUCache<T> {
  private cache = new Map<string, CacheItem<T>>();
  private options: Required<CacheOptions>;

  constructor(options: CacheOptions) {
    this.options = {
      maxSize: options.maxSize,
      maxAge: options.maxAge || 30 * 60 * 1000, // 30 minutes default
      onEvict: options.onEvict || (() => {})
    };
  }

  /**
   * Get item from cache
   */
  get(key: string): T | null {
    const item = this.cache.get(key);
    
    if (!item) {
      return null;
    }
    
    // Check if item has expired
    if (this.isExpired(item)) {
      this.delete(key);
      return null;
    }
    
    // Update access statistics
    item.lastAccessed = Date.now();
    item.accessCount++;
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, item);
    
    return item.value;
  }

  /**
   * Set item in cache
   */
  set(key: string, value: T): void {
    const existingItem = this.cache.get(key);
    
    if (existingItem) {
      // Update existing item
      existingItem.value = value;
      existingItem.lastAccessed = Date.now();
      existingItem.accessCount++;
      
      // Move to end
      this.cache.delete(key);
      this.cache.set(key, existingItem);
      return;
    }
    
    // Create new item
    const item: CacheItem<T> = {
      key,
      value,
      timestamp: Date.now(),
      accessCount: 1,
      lastAccessed: Date.now()
    };
    
    // Evict if necessary
    this.evictIfNecessary();
    
    this.cache.set(key, item);
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    const item = this.cache.get(key);
    return item !== undefined && !this.isExpired(item);
  }

  /**
   * Delete item from cache
   */
  delete(key: string): boolean {
    const item = this.cache.get(key);
    if (item) {
      this.options.onEvict(key, item.value);
      return this.cache.delete(key);
    }
    return false;
  }

  /**
   * Clear all items from cache
   */
  clear(): void {
    for (const [key, item] of this.cache) {
      this.options.onEvict(key, item.value);
    }
    this.cache.clear();
  }

  /**
   * Get all keys in cache
   */
  keys(): string[] {
    this.cleanupExpired();
    return Array.from(this.cache.keys());
  }

  /**
   * Get cache size
   */
  size(): number {
    this.cleanupExpired();
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  stats(): {
    size: number;
    maxSize: number;
    hitRate: number;
    items: Array<{
      key: string;
      age: number;
      accessCount: number;
      lastAccessed: number;
    }>;
  } {
    this.cleanupExpired();
    
    const items = Array.from(this.cache.values()).map(item => ({
      key: item.key,
      age: Date.now() - item.timestamp,
      accessCount: item.accessCount,
      lastAccessed: item.lastAccessed
    }));
    
    const totalAccess = items.reduce((sum, item) => sum + item.accessCount, 0);
    const hitRate = totalAccess > 0 ? totalAccess / (totalAccess + this.cache.size) : 0;
    
    return {
      size: this.cache.size,
      maxSize: this.options.maxSize,
      hitRate,
      items: items.sort((a, b) => b.lastAccessed - a.lastAccessed)
    };
  }

  private isExpired(item: CacheItem<T>): boolean {
    return Date.now() - item.timestamp > this.options.maxAge;
  }

  private evictIfNecessary(): void {
    // Clean up expired items first
    this.cleanupExpired();
    
    // Evict least recently used items if at capacity
    while (this.cache.size >= this.options.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.delete(firstKey);
      } else {
        break;
      }
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    for (const [key, item] of this.cache) {
      if (now - item.timestamp > this.options.maxAge) {
        expiredKeys.push(key);
      }
    }
    
    expiredKeys.forEach(key => this.delete(key));
  }
}

/**
 * Memory-efficient storage for large objects
 */
export class CompressedCache<T> extends LRUCache<T> {
  private compressionEnabled = true;

  constructor(options: CacheOptions & { enableCompression?: boolean }) {
    super(options);
    this.compressionEnabled = options.enableCompression ?? true;
  }

  set(key: string, value: T): void {
    if (this.compressionEnabled && this.shouldCompress(value)) {
      // Implement compression for large objects
      const compressed = this.compress(value);
      super.set(key, compressed as T);
    } else {
      super.set(key, value);
    }
  }

  get(key: string): T | null {
    const value = super.get(key);
    if (value && this.compressionEnabled && this.isCompressed(value)) {
      return this.decompress(value);
    }
    return value;
  }

  private shouldCompress(value: T): boolean {
    // Compress if object is large (rough estimation)
    return JSON.stringify(value).length > 1024; // 1KB threshold
  }

  private isCompressed(value: T): boolean {
    // Simple check for compressed data marker
    return typeof value === 'object' && value !== null && 
           (value as { __compressed?: boolean }).__compressed === true;
  }

  private compress(value: T): { __compressed: true; data: string; originalSize: number } {
    // Simple compression simulation
    // In production, you might use pako or similar
    return {
      __compressed: true,
      data: JSON.stringify(value),
      originalSize: JSON.stringify(value).length
    };
  }

  private decompress(compressed: { __compressed?: boolean; data?: string }): T {
    if (compressed.__compressed && compressed.data) {
      return JSON.parse(compressed.data);
    }
    return compressed as T;
  }
}

/**
 * Preloading cache for anticipatory loading
 */
export class PreloadCache<T> extends LRUCache<T> {
  private preloadQueue = new Set<string>();
  private preloadFunction?: (key: string) => Promise<T>;

  constructor(options: CacheOptions & { 
    preloadFunction?: (key: string) => Promise<T> 
  }) {
    super(options);
    this.preloadFunction = options.preloadFunction;
  }

  /**
   * Preload items in background
   */
  async preload(keys: string[]): Promise<void> {
    if (!this.preloadFunction) {
      return;
    }

    const toPreload = keys.filter(key => 
      !this.has(key) && !this.preloadQueue.has(key)
    );

    const promises = toPreload.map(async (key) => {
      this.preloadQueue.add(key);
      
      try {
        const value = await this.preloadFunction!(key);
        this.set(key, value);
      } catch (error) {
        console.warn(`Failed to preload ${key}:`, error);
      } finally {
        this.preloadQueue.delete(key);
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Check if item is currently being preloaded
   */
  isPreloading(key: string): boolean {
    return this.preloadQueue.has(key);
  }

  /**
   * Get preload queue status
   */
  getPreloadStatus(): {
    queue: string[];
    inProgress: number;
  } {
    return {
      queue: Array.from(this.preloadQueue),
      inProgress: this.preloadQueue.size
    };
  }
}

/**
 * Memory management utilities
 */
export class MemoryManager {
  private static instance: MemoryManager;
  private caches = new Map<string, LRUCache<unknown>>();
  private memoryCheckInterval: NodeJS.Timeout | null = null;

  static getInstance(): MemoryManager {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
    }
    return MemoryManager.instance;
  }

  registerCache(name: string, cache: LRUCache<unknown>): void {
    this.caches.set(name, cache);
    this.startMemoryMonitoring();
  }

  unregisterCache(name: string): void {
    this.caches.delete(name);
    if (this.caches.size === 0) {
      this.stopMemoryMonitoring();
    }
  }

  /**
   * Force cleanup of all caches
   */
  cleanup(): void {
    for (const cache of this.caches.values()) {
      cache.clear();
    }
  }

  /**
   * Get memory usage statistics
   */
  getMemoryStats(): {
    totalCaches: number;
    totalItems: number;
    estimatedMemory: number;
    cacheStats: Record<string, unknown>;
  } {
    let totalItems = 0;
    let estimatedMemory = 0;
    const cacheStats: Record<string, unknown> = {};

    for (const [name, cache] of this.caches) {
      const stats = cache.stats();
      totalItems += stats.size;
      cacheStats[name] = stats;
      
      // Rough memory estimation
      estimatedMemory += stats.size * 1024; // Assume 1KB per item
    }

    return {
      totalCaches: this.caches.size,
      totalItems,
      estimatedMemory,
      cacheStats
    };
  }

  private startMemoryMonitoring(): void {
    if (this.memoryCheckInterval) {
      return;
    }

    this.memoryCheckInterval = setInterval(() => {
      this.checkMemoryPressure();
    }, 30000); // Check every 30 seconds
  }

  private stopMemoryMonitoring(): void {
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
      this.memoryCheckInterval = null;
    }
  }

  private checkMemoryPressure(): void {
    // Simple memory pressure detection
    const stats = this.getMemoryStats();
    
    // If we have too many items, cleanup least used caches
    if (stats.totalItems > 1000) {
      console.warn('High cache usage detected, cleaning up...');
      
      // Clear oldest items from each cache
      for (const cache of this.caches.values()) {
        const cacheStats = cache.stats();
        if (cacheStats.size > 50) {
          // Remove 20% of items
          const toRemove = Math.floor(cacheStats.size * 0.2);
          const oldestItems = cacheStats.items
            .sort((a, b) => a.lastAccessed - b.lastAccessed)
            .slice(0, toRemove);
          
          oldestItems.forEach(item => cache.delete(item.key));
        }
      }
    }
  }
}