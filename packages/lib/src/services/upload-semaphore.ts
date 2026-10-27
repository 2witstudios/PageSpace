import { STORAGE_TIERS } from './storage-limits';
import { releasePendingUpload } from './pending-uploads';
import { loggers } from '../logging/logger-config';
import type { AttachmentTarget } from './attachment-upload-core';

/**
 * Server-trusted upload parameters captured at presign time. /complete reads
 * these from the slot instead of trusting the client request body, so a client
 * cannot presign for one drive/hash/size and complete with another.
 *
 * `driveId` is the drive a page-file (or channel-attachment) upload belongs to;
 * conversation (DM) attachments have no drive and set it to '' while carrying the
 * binding in `attachmentTarget`. `attachmentTarget` is set only by the
 * channel/DM attachment flow — page-file uploads leave it undefined — and binds
 * the slot to a specific page/conversation so /complete can't be replayed
 * against a different target.
 */
export interface UploadSlotMetadata {
  contentHash: string;
  driveId: string;
  fileSize: number;
  mimeType: string;
  attachmentTarget?: AttachmentTarget;
  // H3 (page-file flow): server-trusted fact captured at presign so /complete can
  // gate the dedup link without re-trusting the client. Optional — the attachment
  // flow leaves it unset (it has its own verification path). The authoritative
  // anti-claim check at /complete is the atomic `files`-row ownership claim, not
  // this hint.
  callerAlreadyReferences?: boolean;
}

interface UploadSlot {
  userId: string;
  acquiredAt: Date;
  fileSize: number;
  metadata?: UploadSlotMetadata;
  // L8: set once a completing/cancelling route has taken ownership of this slot
  // (via getSlotMetadata). A claimed slot's DB activeUploads decrement is owned
  // by that route, so the stale-slot sweep must NOT also decrement it (else the
  // counter is double-decremented if the route's work outlives the timeout).
  claimed?: boolean;
}

class UploadSemaphore {
  private static instance: UploadSemaphore;

  private globalPermits: number;
  private userPermits: Map<string, number>;
  private activeSlots: Map<string, UploadSlot>;
  private readonly globalLimit: number;
  private readonly slotTimeout = 10 * 60 * 1000; // 10 minutes max per upload

  private constructor() {
    // Per-process limit: with horizontal scaling each replica enforces this independently.
    const parsedLimit = Number.parseInt(process.env.UPLOAD_MAX_PERMITS ?? '20', 10);
    this.globalLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
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
    fileSize: number,
    metadata?: UploadSlotMetadata
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
    this.activeSlots.set(slotId, { userId, acquiredAt: new Date(), fileSize, metadata });
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

  /**
   * L8: release a slot abandoned past its timeout. An abandoned upload's
   * presign-time `pending_uploads` row is never released by a route, so this
   * path deletes it too (#2154). Unlike the old counter decrement this is
   * merely an optimization — the row's own TTL already returns the concurrency
   * slot even if this process dies — and the delete is idempotent, so a
   * `claimed` slot (owned by an in-flight completion/cancel route) skips it
   * only to avoid redundant work, not to protect a counter.
   *
   * Keep the delete durable anyway: confirm the DB write succeeded BEFORE
   * forgetting the in-memory slot, so a transient failure leaves the slot for
   * the next 60s sweep to retry.
   */
  private async releaseStaleSlot(slotId: string): Promise<void> {
    const slot = this.activeSlots.get(slotId);
    if (!slot) return;

    if (slot.claimed) {
      // An in-flight route owns the pending-upload release; just reclaim the
      // in-memory permit.
      this.releaseUploadSlot(slotId);
      return;
    }

    try {
      await releasePendingUpload(slotId);
    } catch (err) {
      // Keep the slot so the next sweep retries the release; do not forget it.
      loggers.api.warn('Stale-slot pending-upload release failed; will retry next sweep', {
        slotId, userId: slot.userId, err: err as Error,
      });
      return;
    }
    this.releaseUploadSlot(slotId);
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
      // Fire each release; releaseStaleSlot is durable (keeps the slot on DB
      // failure) and self-guards, so an unhandled rejection can't escape here.
      staleSlots.forEach(slotId => { void this.releaseStaleSlot(slotId); });
    }
  }

  verifySlotOwner(slotId: string, userId: string): boolean {
    const slot = this.activeSlots.get(slotId);
    if (!slot || slot.userId !== userId) return false;
    // Reject (and reclaim) slots past the timeout rather than waiting for the
    // once-a-minute sweep — a stale jobId must not still authorize a completion.
    // Reclaim via releaseStaleSlot so the abandoned pending_uploads row is
    // deleted promptly too (its TTL would release it anyway).
    if (Date.now() - slot.acquiredAt.getTime() > this.slotTimeout) {
      void this.releaseStaleSlot(slotId);
      return false;
    }
    return true;
  }

  /**
   * Return the server-trusted metadata captured at presign time for a slot the
   * user owns (and that hasn't expired). Returns null otherwise. Callers use
   * this instead of trusting client-supplied upload parameters.
   */
  getSlotMetadata(slotId: string, userId: string): UploadSlotMetadata | null {
    if (!this.verifySlotOwner(slotId, userId)) return null;
    const slot = this.activeSlots.get(slotId);
    if (!slot) return null;
    // The caller is taking ownership of this slot to complete the upload; mark it
    // claimed so the stale-slot sweep won't also decrement the DB counter while
    // this (possibly long) completion is in flight (see releaseStaleSlot).
    slot.claimed = true;
    return slot.metadata ?? null;
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
