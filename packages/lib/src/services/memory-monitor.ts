import os from 'os';

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

/**
 * Get system memory status
 */
export async function getMemoryStatus(): Promise<MemoryStatus> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Get available memory (free + buffers/cache on Linux)
  // On non-Linux systems, this will be the same as free memory
  let availableMem = freeMem;

  // Try to get more accurate available memory on Linux
  if (process.platform === 'linux') {
    try {
      const { execSync } = require('child_process');
      const memInfo = execSync('cat /proc/meminfo').toString();
      const availableMatch = memInfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (availableMatch) {
        availableMem = parseInt(availableMatch[1]) * 1024; // Convert KB to bytes
      }
    } catch {
      // Fall back to free memory if we can't read /proc/meminfo
    }
  }

  const percentUsed = (usedMem / totalMem) * 100;
  const minFreeMemory = parseInt(process.env.STORAGE_MIN_FREE_MEMORY_MB || '500');

  return {
    totalMB: Math.floor(totalMem / 1024 / 1024),
    freeMB: Math.floor(freeMem / 1024 / 1024),
    usedMB: Math.floor(usedMem / 1024 / 1024),
    availableMB: Math.floor(availableMem / 1024 / 1024),
    percentUsed: Math.round(percentUsed * 100) / 100,
    canAcceptUpload: availableMem > minFreeMemory * 1024 * 1024,
    warningLevel: getWarningLevel(percentUsed)
  };
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
 * Memory protection middleware
 * Use this to automatically reject requests when memory is low
 */
export async function checkMemoryMiddleware(): Promise<{
  allowed: boolean;
  reason?: string;
  status?: MemoryStatus;
}> {
  try {
    const status = await getMemoryStatus();

    if (status.warningLevel === 'critical') {
      return {
        allowed: false,
        reason: 'Server memory critical. Please try again later.',
        status
      };
    }

    if (!status.canAcceptUpload) {
      return {
        allowed: false,
        reason: 'Server is busy. Please try again in a moment.',
        status
      };
    }

    return {
      allowed: true,
      status
    };
  } catch (error) {
    console.error('Memory check failed:', error);
    // Allow request if memory check fails (graceful degradation)
    return {
      allowed: true
    };
  }
}

/**
 * Setup memory monitoring
 * Logs warnings when memory usage is high
 */
export function setupMemoryProtection(intervalMs: number = 30000): NodeJS.Timer {
  return setInterval(async () => {
    try {
      const status = await getMemoryStatus();
      const processInfo = getProcessMemory();

      if (status.warningLevel === 'critical') {
        console.error(`CRITICAL: System memory usage at ${status.percentUsed}% (${status.freeMB}MB free)`);
        console.error(`Process memory: RSS=${processInfo.rss}MB, Heap=${processInfo.heapUsed}MB`);

        // Could trigger cleanup or emergency measures here
        if (global.gc) {
          console.log('Forcing garbage collection...');
          global.gc();
        }
      } else if (status.warningLevel === 'warning') {
        console.warn(`WARNING: System memory usage at ${status.percentUsed}% (${status.freeMB}MB free)`);
        console.warn(`Process memory: RSS=${processInfo.rss}MB, Heap=${processInfo.heapUsed}MB`);
      }

      // Log memory stats periodically for monitoring
      if (process.env.NODE_ENV === 'development') {
        console.log(`Memory: ${status.usedMB}/${status.totalMB}MB (${status.percentUsed}%), Process: RSS=${processInfo.rss}MB`);
      }
    } catch (error) {
      console.error('Memory monitoring error:', error);
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
 * Emergency memory cleanup
 * Call this when memory is critically low
 */
export function emergencyMemoryCleanup(): void {
  console.log('Performing emergency memory cleanup...');

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
    console.log('Forced garbage collection');
  }

  // Clear any caches (implement based on your caching strategy)
  // Example: clearCache();

  // Log memory status after cleanup
  setTimeout(() => {
    const processInfo = getProcessMemory();
    console.log(`Memory after cleanup: RSS=${processInfo.rss}MB, Heap=${processInfo.heapUsed}MB`);
  }, 1000);
}