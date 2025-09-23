import { STORAGE_TIERS } from './storage-limits';
import { getMemoryStatus } from './memory-monitor';
import { loggers } from '../logger-config';

interface UploadSlot {
  userId: string;
  acquiredAt: Date;
  fileSize: number;
}

/**
 * Dynamic upload semaphore with memory-aware limits
 *
 * Features:
 * - Adjusts limits based on available system memory
 * - Configurable via environment variables
 * - Intelligent cleanup and monitoring
 * - Per-user tier limits with global coordination
 */
class UploadSemaphore {
  private static instance: UploadSemaphore;

  private globalPermits: number;
  private userPermits: Map<string, number>;
  private activeSlots: Map<string, UploadSlot>;
  private currentLimit: number;

  // Dynamic configuration
  private readonly baseGlobalPermits: number;
  private readonly maxGlobalPermits: number;
  private readonly slotTimeout = 10 * 60 * 1000; // 10 minutes max per upload

  // Memory-aware scaling
  private lastMemoryCheck = 0;
  private readonly memoryCheckInterval = 30000; // Check memory every 30 seconds

  private constructor() {
    // Load configuration from environment
    this.baseGlobalPermits = parseInt(process.env.UPLOAD_BASE_PERMITS || '3');
    this.maxGlobalPermits = parseInt(process.env.UPLOAD_MAX_PERMITS || '8');

    this.globalPermits = this.baseGlobalPermits;
    this.currentLimit = this.baseGlobalPermits;
    this.userPermits = new Map();
    this.activeSlots = new Map();

    // Cleanup stale slots every minute
    setInterval(() => this.cleanupStaleSlots(), 60000);

    // Update permits based on memory every 30 seconds
    setInterval(() => this.updateDynamicLimits(), this.memoryCheckInterval);

    loggers.api.info('Upload semaphore initialized', {
      baseGlobalPermits: this.baseGlobalPermits,
      maxGlobalPermits: this.maxGlobalPermits,
      slotTimeoutMinutes: this.slotTimeout / 60000
    });
  }

  static getInstance(): UploadSemaphore {
    if (!UploadSemaphore.instance) {
      UploadSemaphore.instance = new UploadSemaphore();
    }
    return UploadSemaphore.instance;
  }

  /**
   * Update dynamic limits based on system memory and load
   */
  private async updateDynamicLimits(): Promise<void> {
    try {
      const memStatus = await getMemoryStatus();
      const now = Date.now();

      // Skip if we checked memory recently
      if (now - this.lastMemoryCheck < this.memoryCheckInterval) {
        return;
      }

      this.lastMemoryCheck = now;

      let newGlobalPermits = this.baseGlobalPermits;

      // Adjust based on memory pressure
      if (memStatus.warningLevel === 'critical') {
        // Reduce permits significantly when memory is critical
        newGlobalPermits = Math.max(1, Math.floor(this.baseGlobalPermits * 0.3));
      } else if (memStatus.warningLevel === 'warning') {
        // Reduce permits moderately when memory is under pressure
        newGlobalPermits = Math.max(2, Math.floor(this.baseGlobalPermits * 0.6));
      } else if (memStatus.percentUsed < 60 && memStatus.availableMB > 1000) {
        // Increase permits when memory is plentiful
        newGlobalPermits = Math.min(this.maxGlobalPermits, this.baseGlobalPermits + 2);
      }

      // Update permits if they changed
      if (newGlobalPermits !== this.currentLimit) {
        const oldLimit = this.currentLimit;
        this.currentLimit = newGlobalPermits;
        const recalculatedAvailable = Math.max(0, this.currentLimit - this.activeSlots.size);
        this.globalPermits = recalculatedAvailable;

        loggers.api.info('Dynamic upload limits adjusted', {
          oldPermits: oldLimit,
          newPermits: newGlobalPermits,
          memoryPercent: memStatus.percentUsed,
          availableMB: memStatus.availableMB,
          warningLevel: memStatus.warningLevel,
          activeUploads: this.activeSlots.size,
          availableSlots: this.globalPermits
        });
      }

    } catch (error) {
      loggers.api.warn('Failed to update dynamic upload limits', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Try to acquire an upload slot with intelligent limits
   * Returns a unique slot ID if successful, null if not
   */
  async acquireUploadSlot(
    userId: string,
    tier: keyof typeof STORAGE_TIERS,
    fileSize: number
  ): Promise<string | null> {
    const startTime = Date.now();

    // Update dynamic limits if needed (throttled)
    await this.updateDynamicLimits();

    // Check global limit (dynamically adjusted)
    if (this.globalPermits <= 0) {
      loggers.api.debug('Upload rejected: Global limit reached', {
        userId,
        fileSize,
        currentPermits: this.globalPermits,
        activeUploads: this.activeSlots.size,
        tier
      });
      return null;
    }

    // Check user limit based on tier
    const userLimit = STORAGE_TIERS[tier].maxConcurrentUploads;
    const currentUserUploads = this.userPermits.get(userId) || 0;

    if (currentUserUploads >= userLimit) {
      loggers.api.debug('Upload rejected: User tier limit reached', {
        userId,
        fileSize,
        currentUserUploads,
        userLimit,
        tier
      });
      return null;
    }

    // Check system memory with cached status
    try {
      const memStatus = await getMemoryStatus();
      if (!memStatus.canAcceptUpload) {
        loggers.api.debug('Upload rejected: Insufficient memory', {
          userId,
          fileSize,
          availableMB: memStatus.availableMB,
          percentUsed: memStatus.percentUsed,
          warningLevel: memStatus.warningLevel
        });
        return null;
      }

      // Additional check for very large files during memory pressure
      if (memStatus.warningLevel === 'warning' && fileSize > 10 * 1024 * 1024) {
        loggers.api.debug('Upload rejected: Large file during memory pressure', {
          userId,
          fileSize,
          fileSizeMB: Math.round(fileSize / 1024 / 1024),
          memoryPercent: memStatus.percentUsed,
          warningLevel: memStatus.warningLevel
        });
        return null;
      }

    } catch (error) {
      loggers.api.warn('Failed to check memory status, allowing upload with graceful degradation', {
        userId,
        fileSize,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Grant permit
    const slotId = `${userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    this.userPermits.set(userId, currentUserUploads + 1);
    this.activeSlots.set(slotId, {
      userId,
      acquiredAt: new Date(),
      fileSize
    });

    // Ensure availability reflects current limit after acquiring the slot
    this.globalPermits = Math.max(0, this.currentLimit - this.activeSlots.size);

    const processingTime = Date.now() - startTime;

    loggers.api.info('Upload slot granted', {
      slotId,
      userId,
      fileSize,
      fileSizeMB: Math.round(fileSize / 1024 / 1024),
      tier,
      globalPermitsRemaining: this.globalPermits,
      userUploadsActive: currentUserUploads + 1,
      processingTimeMs: processingTime
    });

    return slotId;
  }

  /**
   * Release an upload slot with improved tracking
   */
  releaseUploadSlot(slotId: string): void {
    const slot = this.activeSlots.get(slotId);
    if (!slot) {
      loggers.api.warn('Attempted to release non-existent upload slot', { slotId });
      return;
    }

    const { userId, acquiredAt, fileSize } = slot;
    const uploadDurationMs = Date.now() - acquiredAt.getTime();

    this.activeSlots.delete(slotId);

    const currentUserUploads = this.userPermits.get(userId) || 0;
    this.userPermits.set(userId, Math.max(0, currentUserUploads - 1));

    // Clean up user entry if no active uploads
    if ((this.userPermits.get(userId) || 0) === 0) {
      this.userPermits.delete(userId);
    }

    // Recalculate availability using the current limit and remaining active slots
    this.globalPermits = Math.max(0, this.currentLimit - this.activeSlots.size);

    loggers.api.info('Upload slot released', {
      slotId,
      userId,
      fileSize,
      fileSizeMB: Math.round(fileSize / 1024 / 1024),
      uploadDurationMs,
      uploadDurationSeconds: Math.round(uploadDurationMs / 1000),
      globalPermitsNow: this.globalPermits,
      activeUploads: this.activeSlots.size
    });
  }

  /**
   * Check if a user can acquire an upload slot without actually acquiring it
   */
  async canAcquireSlot(userId: string, tier: keyof typeof STORAGE_TIERS): Promise<boolean> {
    // Check global limit
    if (this.globalPermits <= 0) return false;

    // Check user limit
    const userLimit = STORAGE_TIERS[tier].maxConcurrentUploads;
    const currentUserUploads = this.userPermits.get(userId) || 0;
    if (currentUserUploads >= userLimit) return false;

    // Check memory
    try {
      const memStatus = await getMemoryStatus();
      if (!memStatus.canAcceptUpload) return false;
    } catch {
      // Allow if memory check fails
    }

    return true;
  }

  /**
   * Get current semaphore status
   */
  getStatus(): {
    globalSlotsAvailable: number;
    globalSlotsUsed: number;
    userUploads: Map<string, number>;
    activeSlots: number;
    configuredLimit: number;
  } {
    return {
      globalSlotsAvailable: this.globalPermits,
      globalSlotsUsed: this.activeSlots.size,
      userUploads: new Map(this.userPermits),
      activeSlots: this.activeSlots.size,
      configuredLimit: this.currentLimit
    };
  }

  /**
   * Clean up slots that have been held too long (likely from crashed uploads)
   */
  private cleanupStaleSlots(): void {
    const now = Date.now();
    const staleSlots: string[] = [];

    this.activeSlots.forEach((slot, slotId) => {
      const age = now - slot.acquiredAt.getTime();
      if (age > this.slotTimeout) {
        staleSlots.push(slotId);
      }
    });

    if (staleSlots.length > 0) {
      loggers.api.warn('Cleaning up stale upload slots', {
        staleCount: staleSlots.length,
        timeoutMinutes: this.slotTimeout / 60000,
        totalActiveSlots: this.activeSlots.size
      });

      staleSlots.forEach(slotId => this.releaseUploadSlot(slotId));
    }
  }

  /**
   * Force release all slots for a user (e.g., on logout or error)
   */
  releaseUserSlots(userId: string): void {
    const userSlots: string[] = [];

    this.activeSlots.forEach((slot, slotId) => {
      if (slot.userId === userId) {
        userSlots.push(slotId);
      }
    });

    if (userSlots.length > 0) {
      loggers.api.warn('Force releasing user upload slots', { userId, slots: userSlots.length });
      userSlots.forEach(slotId => this.releaseUploadSlot(slotId));
    }
  }

  /**
   * Reset semaphore (for testing or emergency recovery)
   */
  reset(): void {
    this.currentLimit = this.baseGlobalPermits;
    this.globalPermits = this.currentLimit;
    this.userPermits.clear();
    this.activeSlots.clear();
    loggers.api.info('Upload semaphore reset to defaults', {
      limit: this.currentLimit
    });
  }
}

// Export singleton instance
export const uploadSemaphore = UploadSemaphore.getInstance();
