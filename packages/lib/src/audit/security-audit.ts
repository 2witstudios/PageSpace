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
 * Concurrency: logEvent() uses pg_advisory_xact_lock to serialize
 * hash chain writes. The previous hash is always read from the database
 * inside the advisory lock, so multi-instance deployments are safe.
 */

import { createHash } from 'crypto';
import { db, securityAuditLog, sql } from '@pagespace/db';
import type { SecurityEventType, SelectSecurityAuditLog } from '@pagespace/db';
import { queryAuditEvents } from './audit-query';
import { stableStringify } from '../utils/stable-stringify';

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
 * PII fields excluded from hash computation for GDPR compliance (#541).
 * These fields may be anonymized/deleted under right-to-erasure requests,
 * so they must not be part of the hash chain to keep it verifiable.
 *
 * Excluded: userId, sessionId, ipAddress, userAgent, geoLocation
 * Included: eventType, serviceId, resourceType, resourceId, details,
 *           riskScore, anomalyFlags, timestamp, previousHash
 */

/**
 * Compute SHA-256 hash for a security event.
 * Includes previous hash to create the chain link.
 * Excludes PII fields so the chain remains verifiable after GDPR anonymization.
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
  const payload = {
    anomalyFlags: event.anomalyFlags ?? null,
    details: event.details ?? null,
    eventType: event.eventType,
    previousHash,
    resourceId: event.resourceId ?? null,
    resourceType: event.resourceType ?? null,
    riskScore: event.riskScore ?? null,
    serviceId: event.serviceId ?? null,
    timestamp: timestamp.toISOString(),
  };

  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Security Audit Service with hash chain integrity.
 *
 * Must be initialized before first use by calling initialize().
 * Each logEvent() reads the previous hash from the DB inside an advisory lock,
 * so multi-instance deployments are safe without any in-memory state.
 */
export class SecurityAuditService {
  private initialized = false;

  /**
   * Mark the service as initialized. Retained for callers that invoke it at
   * app startup; logEvent() also self-initializes. Idempotent.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async initialize(): Promise<void> {
    this.initialized = true;
  }

  /**
   * Advisory lock key for serializing hash chain writes.
   * Uses a fixed bigint derived from the string 'security_audit_chain'.
   * pg_advisory_xact_lock holds the lock until the transaction commits/rolls back.
   */
  static readonly CHAIN_LOCK_KEY = 8370291546;

  /**
   * Log a security event with hash chain integrity.
   *
   * Uses a PostgreSQL advisory lock to serialize concurrent writes and prevent
   * hash chain forking. Advisory locks work even when the table is empty (genesis),
   * unlike FOR UPDATE which requires an existing row to lock.
   *
   * @param event - The security event to log
   */
  async logEvent(event: AuditEvent): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const timestamp = new Date();

    await db.transaction(async (tx) => {
      // Acquire advisory lock scoped to this transaction.
      // Blocks concurrent writers until this transaction completes.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SecurityAuditService.CHAIN_LOCK_KEY})`);

      // Read the latest hash — safe from races under the advisory lock
      const lastRecord = await tx.execute(sql`
        SELECT event_hash
        FROM security_audit_log
        ORDER BY chain_seq DESC
        LIMIT 1
      `);

      const previousHash = (lastRecord.rows[0] as { event_hash: string } | undefined)?.event_hash ?? 'genesis';

      const eventHash = computeSecurityEventHash(event, previousHash, timestamp);

      await tx.insert(securityAuditLog).values({
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

    });
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
   * Delegates to the standalone queryAuditEvents() function.
   */
  async queryEvents(options: QueryEventsOptions): Promise<SelectSecurityAuditLog[]> {
    return queryAuditEvents(options);
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
