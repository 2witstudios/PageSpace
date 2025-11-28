import os from 'os';
import { loggers } from '../logging/logger-config';

export interface MemoryStatus {
  totalMB: number;
  freeMB: number;
  usedMB: number;
  availableMB: number;
  percentUsed: number;
  canAcceptUpload: boolean;
  warningLevel: 'normal' | 'warning' | 'critical';
}

export interface ProcessMemoryInfo {
  rss: number; // Resident Set Size
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

// Cache for memory status to avoid expensive system calls
interface MemoryCache {
  status: MemoryStatus;
  timestamp: number;
  ttl: number;
}

let memoryCache: MemoryCache | null = null;
const MEMORY_CACHE_TTL = 5000; // 5 seconds cache

/**
 * Get system memory status (with intelligent caching)
 *
 * Performance improvements:
 * - Caches results for 5 seconds to avoid repeated system calls
 * - Uses native Node.js APIs instead of execSync
 * - Graceful fallback when platform-specific features aren't available
 */
export async function getMemoryStatus(): Promise<MemoryStatus> {
  const now = Date.now();

  // Return cached result if still valid
  if (memoryCache && (now - memoryCache.timestamp) < memoryCache.ttl) {
    return memoryCache.status;
  }

  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // For most platforms, available memory equals free memory
    let availableMem = freeMem;

    // Try to get more accurate available memory on Linux using native fs API
    if (process.platform === 'linux') {
      try {
        const fs = await import('fs/promises');
        const memInfo = await fs.readFile('/proc/meminfo', 'utf8');
        const availableMatch = memInfo.match(/MemAvailable:\s+(\d+)\s+kB/);
        if (availableMatch) {
          availableMem = parseInt(availableMatch[1]) * 1024; // Convert KB to bytes
        }
      } catch (error) {
        // Fall back to free memory if we can't read /proc/meminfo
        loggers.api.debug('Failed to read /proc/meminfo, using os.freemem()', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const percentUsed = (usedMem / totalMem) * 100;
    const minFreeMemory = parseInt(process.env.STORAGE_MIN_FREE_MEMORY_MB || '500');

    const status: MemoryStatus = {
      totalMB: Math.floor(totalMem / 1024 / 1024),
      freeMB: Math.floor(freeMem / 1024 / 1024),
      usedMB: Math.floor(usedMem / 1024 / 1024),
      availableMB: Math.floor(availableMem / 1024 / 1024),
      percentUsed: Math.round(percentUsed * 100) / 100,
      canAcceptUpload: availableMem > minFreeMemory * 1024 * 1024,
      warningLevel: getWarningLevel(percentUsed)
    };

    // Cache the result
    memoryCache = {
      status,
      timestamp: now,
      ttl: MEMORY_CACHE_TTL
    };

    return status;

  } catch (error) {
    loggers.api.error('Error getting memory status', {
      error: error instanceof Error ? error.message : String(error)
    });

    // Return a safe fallback status on error
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const percentUsed = (usedMem / totalMem) * 100;

    return {
      totalMB: Math.floor(totalMem / 1024 / 1024),
      freeMB: Math.floor(freeMem / 1024 / 1024),
      usedMB: Math.floor(usedMem / 1024 / 1024),
      availableMB: Math.floor(freeMem / 1024 / 1024),
      percentUsed: Math.round(percentUsed * 100) / 100,
      canAcceptUpload: freeMem > 500 * 1024 * 1024, // Conservative 500MB minimum
      warningLevel: getWarningLevel(percentUsed)
    };
  }
}

/**
 * Get current process memory usage
 */
export function getProcessMemory(): ProcessMemoryInfo {
  const mem = process.memoryUsage();
  return {
    rss: Math.floor(mem.rss / 1024 / 1024), // MB
    heapTotal: Math.floor(mem.heapTotal / 1024 / 1024), // MB
    heapUsed: Math.floor(mem.heapUsed / 1024 / 1024), // MB
    external: Math.floor(mem.external / 1024 / 1024), // MB
    arrayBuffers: Math.floor(mem.arrayBuffers / 1024 / 1024) // MB
  };
}

/**
 * Check if system has enough memory for an upload
 */
export async function hasEnoughMemoryForUpload(fileSize: number): Promise<boolean> {
  const status = await getMemoryStatus();

  // Estimate memory needed (file size * 3 for processing overhead)
  const estimatedMemoryMB = Math.ceil((fileSize * 3) / 1024 / 1024);

  // Need the estimated memory plus 500MB buffer
  const requiredFreeMB = estimatedMemoryMB + 500;

  return status.availableMB >= requiredFreeMB;
}

/**
 * Get memory warning level
 */
function getWarningLevel(percentUsed: number): 'normal' | 'warning' | 'critical' {
  if (percentUsed >= 90) return 'critical';
  if (percentUsed >= 80) return 'warning';
  return 'normal';
}

/**
 * Memory protection middleware (optimized for performance)
 *
 * Performance improvements:
 * - Uses cached memory status (5-second TTL)
 * - Structured logging instead of console.error
 * - More granular memory level checking
 */
export async function checkMemoryMiddleware(): Promise<{
  allowed: boolean;
  reason?: string;
  status?: MemoryStatus;
}> {
  try {
    const status = await getMemoryStatus();

    // Critical memory situation - reject immediately
    if (status.warningLevel === 'critical') {
      loggers.api.warn('Request rejected due to critical memory usage', {
        percentUsed: status.percentUsed,
        availableMB: status.availableMB,
        warningLevel: status.warningLevel
      });

      return {
        allowed: false,
        reason: 'Server memory critical. Please try again later.',
        status
      };
    }

    // Check if we can accept uploads based on available memory
    if (!status.canAcceptUpload) {
      loggers.api.debug('Request rejected due to insufficient memory for uploads', {
        percentUsed: status.percentUsed,
        availableMB: status.availableMB,
        canAcceptUpload: status.canAcceptUpload
      });

      return {
        allowed: false,
        reason: 'Server is busy processing other requests. Please try again in a moment.',
        status
      };
    }

    // Log warning level but allow request
    if (status.warningLevel === 'warning') {
      loggers.api.debug('Memory usage in warning range, but allowing request', {
        percentUsed: status.percentUsed,
        availableMB: status.availableMB,
        warningLevel: status.warningLevel
      });
    }

    return {
      allowed: true,
      status
    };

  } catch (error) {
    loggers.api.error('Memory check failed, allowing request with graceful degradation', {
      error: error instanceof Error ? error.message : String(error)
    });

    // Allow request if memory check fails (graceful degradation)
    return {
      allowed: true
    };
  }
}

/**
 * Setup memory monitoring with structured logging
 *
 * Performance improvements:
 * - Uses structured logging instead of console.log
 * - More efficient memory monitoring
 * - Configurable logging levels
 */
export function setupMemoryProtection(intervalMs: number = 30000): NodeJS.Timer {
  return setInterval(async () => {
    try {
      const status = await getMemoryStatus();
      const processInfo = getProcessMemory();

      if (status.warningLevel === 'critical') {
        loggers.api.error('CRITICAL: System memory usage critically high', {
          percentUsed: status.percentUsed,
          freeMB: status.freeMB,
          availableMB: status.availableMB,
          processRSS: processInfo.rss,
          processHeap: processInfo.heapUsed,
          warningLevel: status.warningLevel
        });

        // Trigger garbage collection if available
        if (global.gc) {
          loggers.api.info('Forcing garbage collection due to critical memory usage');
          global.gc();
        }

      } else if (status.warningLevel === 'warning') {
        loggers.api.warn('WARNING: System memory usage high', {
          percentUsed: status.percentUsed,
          freeMB: status.freeMB,
          availableMB: status.availableMB,
          processRSS: processInfo.rss,
          processHeap: processInfo.heapUsed,
          warningLevel: status.warningLevel
        });
      }

      // Log memory stats periodically for monitoring (debug level)
      loggers.api.debug('Memory monitoring stats', {
        system: {
          used: status.usedMB,
          total: status.totalMB,
          percentUsed: status.percentUsed,
          available: status.availableMB
        },
        process: {
          rss: processInfo.rss,
          heapUsed: processInfo.heapUsed,
          heapTotal: processInfo.heapTotal,
          external: processInfo.external
        },
        canAcceptUpload: status.canAcceptUpload,
        warningLevel: status.warningLevel
      });

    } catch (error) {
      loggers.api.error('Memory monitoring error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, intervalMs);
}

/**
 * Format memory size in MB to human-readable string
 */
export function formatMemory(mb: number): string {
  if (mb < 1024) {
    return `${mb}MB`;
  }
  return `${(mb / 1024).toFixed(2)}GB`;
}

/**
 * Emergency memory cleanup with structured logging
 */
export function emergencyMemoryCleanup(): void {
  loggers.api.warn('Performing emergency memory cleanup');

  const beforeCleanup = getProcessMemory();

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
    loggers.api.info('Forced garbage collection during emergency cleanup');
  }

  // Clear permission cache if available (helps free memory)
  try {
    // Dynamic import to avoid circular dependencies
    import('./permission-cache').then(({ permissionCache }) => {
      permissionCache.clearAll();
      loggers.api.info('Cleared permission cache during emergency cleanup');
    }).catch(() => {
      // Permission cache not available, ignore
    });
  } catch {
    // Ignore errors during emergency cleanup
  }

  // Log memory status after cleanup
  setTimeout(() => {
    const afterCleanup = getProcessMemory();
    const rssDiff = beforeCleanup.rss - afterCleanup.rss;
    const heapDiff = beforeCleanup.heapUsed - afterCleanup.heapUsed;

    loggers.api.info('Emergency memory cleanup completed', {
      before: {
        rss: beforeCleanup.rss,
        heap: beforeCleanup.heapUsed
      },
      after: {
        rss: afterCleanup.rss,
        heap: afterCleanup.heapUsed
      },
      freed: {
        rss: rssDiff,
        heap: heapDiff
      }
    });
  }, 1000);
}