import { getMemoryStatus } from './memory-monitor';
import { getStorageConfigFromSubscription, type StorageTier } from './subscription-utils';

interface UploadSlot {
  userId: string;
  acquiredAt: Date;
  fileSize: number;
}

/**
 * Semaphore to limit concurrent uploads and prevent memory exhaustion
 * Singleton pattern to ensure global limits are enforced
 */
class UploadSemaphore {
  private static instance: UploadSemaphore;

  private globalPermits: number;
  private readonly maxGlobalPermits = 5; // Max 5 uploads system-wide
  private userPermits: Map<string, number>;
  private activeSlots: Map<string, UploadSlot>;
  private readonly slotTimeout = 5 * 60 * 1000; // 5 minutes max per upload

  private constructor() {
    this.globalPermits = this.maxGlobalPermits;
    this.userPermits = new Map();
    this.activeSlots = new Map();

    // Cleanup stale slots every minute
    setInterval(() => this.cleanupStaleSlots(), 60000);
  }

  static getInstance(): UploadSemaphore {
    if (!UploadSemaphore.instance) {
      UploadSemaphore.instance = new UploadSemaphore();
    }
    return UploadSemaphore.instance;
  }

  /**
   * Try to acquire an upload slot
   * Returns a unique slot ID if successful, null if not
   */
  async acquireUploadSlot(
    userId: string,
    tier: StorageTier,
    fileSize: number
  ): Promise<string | null> {
    // Check global limit
    if (this.globalPermits <= 0) {
      console.log(`Upload rejected: Global limit reached (${this.maxGlobalPermits} concurrent uploads)`);
      return null;
    }

    // Check user limit based on tier
    const tierConfig = getStorageConfigFromSubscription(tier);
    const userLimit = tierConfig.maxConcurrentUploads;
    const currentUserUploads = this.userPermits.get(userId) || 0;

    if (currentUserUploads >= userLimit) {
      console.log(`Upload rejected: User ${userId} limit reached (${userLimit} concurrent uploads for ${tier} tier)`);
      return null;
    }

    // Check system memory (must have 500MB free)
    try {
      const memStatus = await getMemoryStatus();
      if (!memStatus.canAcceptUpload) {
        console.log(`Upload rejected: Insufficient memory (${memStatus.freeMB}MB free, need 500MB)`);
        return null;
      }
    } catch (error) {
      console.error('Failed to check memory status:', error);
      // Allow upload if memory check fails (graceful degradation)
    }

    // Grant permit
    const slotId = `${userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    this.globalPermits--;
    this.userPermits.set(userId, currentUserUploads + 1);
    this.activeSlots.set(slotId, {
      userId,
      acquiredAt: new Date(),
      fileSize
    });

    console.log(`Upload slot granted: ${slotId} (User: ${userId}, Size: ${fileSize}, Global: ${this.globalPermits}/${this.maxGlobalPermits})`);

    return slotId;
  }

  /**
   * Release an upload slot
   */
  releaseUploadSlot(slotId: string): void {
    const slot = this.activeSlots.get(slotId);
    if (!slot) {
      console.warn(`Attempted to release non-existent slot: ${slotId}`);
      return;
    }

    // Release permits
    this.globalPermits++;
    const currentUserUploads = this.userPermits.get(slot.userId) || 0;
    this.userPermits.set(slot.userId, Math.max(0, currentUserUploads - 1));

    // Clean up user entry if no active uploads
    if (this.userPermits.get(slot.userId) === 0) {
      this.userPermits.delete(slot.userId);
    }

    this.activeSlots.delete(slotId);

    const duration = Date.now() - slot.acquiredAt.getTime();
    console.log(`Upload slot released: ${slotId} (Duration: ${Math.round(duration / 1000)}s, Global: ${this.globalPermits}/${this.maxGlobalPermits})`);
  }

  /**
   * Check if a user can acquire an upload slot without actually acquiring it
   */
  async canAcquireSlot(userId: string, tier: StorageTier): Promise<boolean> {
    // Check global limit
    if (this.globalPermits <= 0) return false;

    // Check user limit
    const tierConfig = getStorageConfigFromSubscription(tier);
    const userLimit = tierConfig.maxConcurrentUploads;
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
  } {
    return {
      globalSlotsAvailable: this.globalPermits,
      globalSlotsUsed: this.maxGlobalPermits - this.globalPermits,
      userUploads: new Map(this.userPermits),
      activeSlots: this.activeSlots.size
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
      console.log(`Cleaning up ${staleSlots.length} stale upload slots`);
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
      console.log(`Releasing ${userSlots.length} slots for user ${userId}`);
      userSlots.forEach(slotId => this.releaseUploadSlot(slotId));
    }
  }

  /**
   * Reset semaphore (for testing or emergency recovery)
   */
  reset(): void {
    this.globalPermits = this.maxGlobalPermits;
    this.userPermits.clear();
    this.activeSlots.clear();
    console.log('Upload semaphore reset');
  }
}

// Export singleton instance
export const uploadSemaphore = UploadSemaphore.getInstance();