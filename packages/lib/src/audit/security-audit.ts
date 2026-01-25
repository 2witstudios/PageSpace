/**
 * Security Audit Service
 *
 * Provides tamper-evident security event logging with hash chain integrity.
 * Part of the Zero-Trust Security Architecture (Phase 5).
 *
 * Features:
 * - Hash chain linking for tamper detection
 * - Comprehensive security event logging
 * - Convenience methods for common events
 * - Query interface for forensic analysis
 *
 * IMPORTANT: Multi-instance considerations
 * - This service maintains an in-memory lastHash for the hash chain
 * - In multi-instance deployments, use database-backed state instead:
 *   1. Use a Redis lock or database advisory lock before inserting
 *   2. Always read the latest hash from DB within the transaction
 *   3. Or use a dedicated single-instance audit writer service
 *
 * For production cloud deployments, consider:
 * - Running as a singleton service behind a queue
 * - Using database sequences for ordering
 * - Accepting eventual consistency with per-instance chains merged later
 */

import { createHash } from 'crypto';
import { db, securityAuditLog, desc, and, gte, lte, eq } from '@pagespace/db';
import type { SecurityEventType, SelectSecurityAuditLog } from '@pagespace/db';

/**
 * Audit event input structure
 */
export interface AuditEvent {
  eventType: SecurityEventType;
  userId?: string;
  sessionId?: string;
  serviceId?: string;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  geoLocation?: string;
  details?: Record<string, unknown>;
  riskScore?: number;
  anomalyFlags?: string[];
}

/**
 * Query options for retrieving audit events
 */
export interface QueryEventsOptions {
  userId?: string;
  eventType?: SecurityEventType;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string;
  fromTimestamp?: Date;
  toTimestamp?: Date;
  limit?: number;
}

/**
 * Compute SHA-256 hash for a security event.
 * Includes previous hash to create the chain link.
 *
 * @param event - The event data
 * @param previousHash - Hash of the previous event (or 'genesis' for first event)
 * @param timestamp - Event timestamp
 * @returns Hexadecimal SHA-256 hash string
 */
export function computeSecurityEventHash(
  event: AuditEvent,
  previousHash: string,
  timestamp: Date
): string {
  const data = JSON.stringify({
    eventType: event.eventType,
    userId: event.userId,
    sessionId: event.sessionId,
    serviceId: event.serviceId,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    geoLocation: event.geoLocation,
    details: event.details,
    riskScore: event.riskScore,
    anomalyFlags: event.anomalyFlags,
    timestamp: timestamp.toISOString(),
    previousHash,
  });

  return createHash('sha256').update(data).digest('hex');
}

/**
 * Security Audit Service with hash chain integrity.
 *
 * Maintains an in-memory reference to the last hash for building the chain.
 * Must be initialized before use by calling initialize().
 */
export class SecurityAuditService {
  private lastHash: string = 'genesis';
  private initialized = false;
  private initializePromise: Promise<void> | null = null;

  /**
   * Initialize the service by loading the last hash from the database.
   * Call this during service startup, not lazily.
   *
   * This method is idempotent - calling it multiple times is safe.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Prevent concurrent initialization
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this._doInitialize();
    await this.initializePromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      const lastEvent = await db.query.securityAuditLog.findFirst({
        orderBy: desc(securityAuditLog.timestamp),
        columns: { eventHash: true },
      });

      this.lastHash = lastEvent?.eventHash ?? 'genesis';
      this.initialized = true;
    } catch (error) {
      // Reset promise so initialization can be retried
      this.initializePromise = null;
      throw error;
    }
  }

  /**
   * Log a security event with hash chain integrity.
   *
   * @param event - The security event to log
   */
  async logEvent(event: AuditEvent): Promise<void> {
    // Ensure initialized (fallback for lazy init, but prefer explicit init)
    if (!this.initialized) {
      await this.initialize();
    }

    const timestamp = new Date();
    const previousHash = this.lastHash;

    // Compute hash for this event
    const eventHash = computeSecurityEventHash(event, previousHash, timestamp);

    // Insert the event
    await db.insert(securityAuditLog).values({
      eventType: event.eventType,
      userId: event.userId,
      sessionId: event.sessionId,
      serviceId: event.serviceId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      geoLocation: event.geoLocation,
      details: event.details,
      riskScore: event.riskScore,
      anomalyFlags: event.anomalyFlags,
      timestamp,
      previousHash,
      eventHash,
    });

    // Update lastHash for next event
    this.lastHash = eventHash;
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * Log successful authentication.
   */
  async logAuthSuccess(
    userId: string,
    sessionId: string,
    ipAddress: string,
    userAgent: string
  ): Promise<void> {
    return this.logEvent({
      eventType: 'auth.login.success',
      userId,
      sessionId,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Log failed authentication attempt.
   */
  async logAuthFailure(
    attemptedUser: string,
    ipAddress: string,
    reason: string
  ): Promise<void> {
    return this.logEvent({
      eventType: 'auth.login.failure',
      ipAddress,
      details: { attemptedUser, reason },
      riskScore: 0.3,
    });
  }

  /**
   * Log access denied event.
   */
  async logAccessDenied(
    userId: string,
    resourceType: string,
    resourceId: string,
    reason: string
  ): Promise<void> {
    return this.logEvent({
      eventType: 'authz.access.denied',
      userId,
      resourceType,
      resourceId,
      details: { reason },
      riskScore: 0.5,
    });
  }

  /**
   * Log token creation event.
   */
  async logTokenCreated(
    userId: string,
    tokenType: string,
    ipAddress?: string
  ): Promise<void> {
    return this.logEvent({
      eventType: 'auth.token.created',
      userId,
      ipAddress,
      details: { tokenType },
    });
  }

  /**
   * Log token revocation event.
   */
  async logTokenRevoked(
    userId: string,
    tokenType: string,
    reason: string
  ): Promise<void> {
    return this.logEvent({
      eventType: 'auth.token.revoked',
      userId,
      details: { tokenType, reason },
    });
  }

  /**
   * Log security anomaly detection.
   */
  async logAnomalyDetected(
    userId: string,
    ipAddress: string,
    riskScore: number,
    anomalyFlags: string[]
  ): Promise<void> {
    return this.logEvent({
      eventType: 'security.anomaly.detected',
      userId,
      ipAddress,
      riskScore,
      anomalyFlags,
    });
  }

  /**
   * Log data access event.
   */
  async logDataAccess(
    userId: string,
    operation: 'read' | 'write' | 'delete' | 'export' | 'share',
    resourceType: string,
    resourceId: string,
    details?: Record<string, unknown>
  ): Promise<void> {
    const eventTypeMap: Record<string, SecurityEventType> = {
      read: 'data.read',
      write: 'data.write',
      delete: 'data.delete',
      export: 'data.export',
      share: 'data.share',
    };

    return this.logEvent({
      eventType: eventTypeMap[operation],
      userId,
      resourceType,
      resourceId,
      details,
    });
  }

  /**
   * Log password change event.
   */
  async logPasswordChanged(
    userId: string,
    ipAddress: string
  ): Promise<void> {
    return this.logEvent({
      eventType: 'auth.password.changed',
      userId,
      ipAddress,
    });
  }

  /**
   * Log logout event.
   */
  async logLogout(
    userId: string,
    sessionId: string,
    ipAddress?: string
  ): Promise<void> {
    return this.logEvent({
      eventType: 'auth.logout',
      userId,
      sessionId,
      ipAddress,
    });
  }

  /**
   * Log rate limiting event.
   */
  async logRateLimited(
    ipAddress: string,
    endpoint: string,
    userId?: string
  ): Promise<void> {
    return this.logEvent({
      eventType: 'security.rate.limited',
      userId,
      ipAddress,
      details: { endpoint },
      riskScore: 0.4,
    });
  }

  /**
   * Log brute force detection.
   */
  async logBruteForceDetected(
    ipAddress: string,
    attemptCount: number,
    targetUser?: string
  ): Promise<void> {
    return this.logEvent({
      eventType: 'security.brute.force.detected',
      ipAddress,
      details: { attemptCount, targetUser },
      riskScore: 0.8,
      anomalyFlags: ['brute_force'],
    });
  }

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  /**
   * Query audit events with filtering options.
   *
   * @param options - Query filtering options
   * @returns Array of matching audit events
   */
  async queryEvents(options: QueryEventsOptions): Promise<SelectSecurityAuditLog[]> {
    const conditions = [];

    if (options.userId) {
      conditions.push(eq(securityAuditLog.userId, options.userId));
    }

    if (options.eventType) {
      conditions.push(eq(securityAuditLog.eventType, options.eventType));
    }

    if (options.resourceType) {
      conditions.push(eq(securityAuditLog.resourceType, options.resourceType));
    }

    if (options.resourceId) {
      conditions.push(eq(securityAuditLog.resourceId, options.resourceId));
    }

    if (options.ipAddress) {
      conditions.push(eq(securityAuditLog.ipAddress, options.ipAddress));
    }

    if (options.fromTimestamp) {
      conditions.push(gte(securityAuditLog.timestamp, options.fromTimestamp));
    }

    if (options.toTimestamp) {
      conditions.push(lte(securityAuditLog.timestamp, options.toTimestamp));
    }

    const query = db
      .select()
      .from(securityAuditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(securityAuditLog.timestamp));

    return query;
  }

  /**
   * Get the current last hash (for debugging/verification).
   */
  getLastHash(): string {
    return this.lastHash;
  }

  /**
   * Check if the service is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Singleton instance for application-wide use.
 * Call securityAudit.initialize() during app startup.
 */
export const securityAudit = new SecurityAuditService();
