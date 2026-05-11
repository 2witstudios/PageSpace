import { STORAGE_TIERS } from './storage-limits';
import { loggers } from '../logging/logger-config';

interface UploadSlot {
  userId: string;
  acquiredAt: Date;
  fileSize: number;
}

class UploadSemaphore {
  private static instance: UploadSemaphore;

  private globalPermits: number;
  private userPermits: Map<string, number>;
  private activeSlots: Map<string, UploadSlot>;
  private readonly globalLimit: number;
  private readonly slotTimeout = 10 * 60 * 1000; // 10 minutes max per upload

  private constructor() {
    this.globalLimit = parseInt(process.env.UPLOAD_MAX_PERMITS || '20');
    this.globalPermits = this.globalLimit;
    this.userPermits = new Map();
    this.activeSlots = new Map();

    setInterval(() => this.cleanupStaleSlots(), 60000);

    loggers.api.info('Upload semaphore initialized', {
      globalLimit: this.globalLimit,
      slotTimeoutMinutes: this.slotTimeout / 60000,
    });
  }

  static getInstance(): UploadSemaphore {
    if (!UploadSemaphore.instance) {
      UploadSemaphore.instance = new UploadSemaphore();
    }
    return UploadSemaphore.instance;
  }

  async acquireUploadSlot(
    userId: string,
    tier: keyof typeof STORAGE_TIERS,
    fileSize: number
  ): Promise<string | null> {
    if (this.globalPermits <= 0) {
      loggers.api.debug('Upload rejected: global limit reached', {
        userId, fileSize, activeUploads: this.activeSlots.size, tier,
      });
      return null;
    }

    const userLimit = STORAGE_TIERS[tier].maxConcurrentUploads;
    const currentUserUploads = this.userPermits.get(userId) || 0;

    if (currentUserUploads >= userLimit) {
      loggers.api.debug('Upload rejected: user tier limit reached', {
        userId, fileSize, currentUserUploads, userLimit, tier,
      });
      return null;
    }

    const slotId = `${userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.userPermits.set(userId, currentUserUploads + 1);
    this.activeSlots.set(slotId, { userId, acquiredAt: new Date(), fileSize });
    this.globalPermits = Math.max(0, this.globalLimit - this.activeSlots.size);

    loggers.api.info('Upload slot granted', {
      slotId, userId, fileSize, tier,
      fileSizeMB: Math.round(fileSize / 1024 / 1024),
      globalPermitsRemaining: this.globalPermits,
    });

    return slotId;
  }

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
    if ((this.userPermits.get(userId) || 0) === 0) {
      this.userPermits.delete(userId);
    }

    this.globalPermits = Math.max(0, this.globalLimit - this.activeSlots.size);

    loggers.api.info('Upload slot released', {
      slotId, userId, fileSize,
      fileSizeMB: Math.round(fileSize / 1024 / 1024),
      uploadDurationMs,
      globalPermitsNow: this.globalPermits,
    });
  }

  async canAcquireSlot(userId: string, tier: keyof typeof STORAGE_TIERS): Promise<boolean> {
    if (this.globalPermits <= 0) return false;
    const userLimit = STORAGE_TIERS[tier].maxConcurrentUploads;
    const currentUserUploads = this.userPermits.get(userId) || 0;
    return currentUserUploads < userLimit;
  }

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
      configuredLimit: this.globalLimit,
    };
  }

  private cleanupStaleSlots(): void {
    const now = Date.now();
    const staleSlots: string[] = [];

    this.activeSlots.forEach((slot, slotId) => {
      if (now - slot.acquiredAt.getTime() > this.slotTimeout) {
        staleSlots.push(slotId);
      }
    });

    if (staleSlots.length > 0) {
      loggers.api.warn('Cleaning up stale upload slots', {
        staleCount: staleSlots.length,
        timeoutMinutes: this.slotTimeout / 60000,
      });
      staleSlots.forEach(slotId => this.releaseUploadSlot(slotId));
    }
  }

  releaseUserSlots(userId: string): void {
    const userSlots: string[] = [];
    this.activeSlots.forEach((slot, slotId) => {
      if (slot.userId === userId) userSlots.push(slotId);
    });

    if (userSlots.length > 0) {
      loggers.api.warn('Force releasing user upload slots', { userId, slots: userSlots.length });
      userSlots.forEach(slotId => this.releaseUploadSlot(slotId));
    }
  }

  reset(): void {
    this.globalPermits = this.globalLimit;
    this.userPermits.clear();
    this.activeSlots.clear();
    loggers.api.info('Upload semaphore reset', { limit: this.globalLimit });
  }
}

export const uploadSemaphore = UploadSemaphore.getInstance();
