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
import { db } from '@pagespace/db/db';
import type { SecurityEventType, SelectSecurityAuditLog } from '@pagespace/db/schema/security-audit';
import { queryAuditEvents } from './audit-query';
import { stableStringify } from '../utils/stable-stringify';
import { createSecurityAuditRepository, type SecurityAuditRepository } from './security-audit-repository';

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
 * Advisory lock key for serializing hash chain writes.
 * Uses a fixed bigint derived from the string 'security_audit_chain'.
 * pg_advisory_xact_lock holds the lock until the transaction commits/rolls back.
 * Must match SECURITY_AUDIT_CHAIN_LOCK_KEY in security-audit-repository.ts.
 */
export const CHAIN_LOCK_KEY = 8370291546;

export interface SecurityAuditServiceDeps {
  repository: SecurityAuditRepository;
}

export interface SecurityAuditService {
  /**
   * Mark the service as initialized. Retained for callers that invoke it at
   * app startup; logEvent() also self-initializes. Idempotent.
   */
  initialize(): Promise<void>;
  isInitialized(): boolean;
  logEvent(event: AuditEvent): Promise<void>;
  logAuthSuccess(userId: string, sessionId: string, ipAddress: string, userAgent: string): Promise<void>;
  logAuthFailure(attemptedUser: string, ipAddress: string, reason: string): Promise<void>;
  logAccessDenied(userId: string, resourceType: string, resourceId: string, reason: string): Promise<void>;
  logTokenCreated(userId: string, tokenType: string, ipAddress?: string): Promise<void>;
  logTokenRevoked(userId: string, tokenType: string, reason: string): Promise<void>;
  logAnomalyDetected(userId: string, ipAddress: string, riskScore: number, anomalyFlags: string[]): Promise<void>;
  logDataAccess(
    userId: string,
    operation: 'read' | 'write' | 'delete' | 'export' | 'share',
    resourceType: string,
    resourceId: string,
    details?: Record<string, unknown>
  ): Promise<void>;
  logLogout(userId: string, sessionId: string, ipAddress?: string): Promise<void>;
  logRateLimited(ipAddress: string, endpoint: string, userId?: string): Promise<void>;
  logBruteForceDetected(ipAddress: string, attemptCount: number, targetUser?: string): Promise<void>;
  /** Query audit events with filtering options. Delegates to queryAuditEvents(). */
  queryEvents(options: QueryEventsOptions): Promise<SelectSecurityAuditLog[]>;
}

/**
 * Build a Security Audit Service with hash chain integrity from an injected
 * repository. Must be initialized before first use by calling initialize().
 * Each logEvent() reads the previous hash from the DB inside an advisory lock
 * (see the repository), so multi-instance deployments are safe without any
 * in-memory state beyond the `initialized` flag.
 */
export function createSecurityAuditService({ repository }: SecurityAuditServiceDeps): SecurityAuditService {
  let initialized = false;

  // Convenience methods call `api.logEvent(...)` (not a bare closure reference)
  // so that replacing `api.logEvent` — e.g. via a test spy — is observed by
  // every wrapper, matching the previous class's `this.logEvent` semantics.
  const api: SecurityAuditService = {
    async initialize(): Promise<void> {
      initialized = true;
    },

    isInitialized(): boolean {
      return initialized;
    },

    async logEvent(event: AuditEvent): Promise<void> {
      if (!initialized) {
        await api.initialize();
      }

      return repository.appendEvent(event);
    },

    async logAuthSuccess(
      userId: string,
      sessionId: string,
      ipAddress: string,
      userAgent: string
    ): Promise<void> {
      return api.logEvent({
        eventType: 'auth.login.success',
        userId,
        sessionId,
        ipAddress,
        userAgent,
      });
    },

    async logAuthFailure(
      attemptedUser: string,
      ipAddress: string,
      reason: string
    ): Promise<void> {
      return api.logEvent({
        eventType: 'auth.login.failure',
        ipAddress,
        details: { attemptedUser, reason },
        riskScore: 0.3,
      });
    },

    async logAccessDenied(
      userId: string,
      resourceType: string,
      resourceId: string,
      reason: string
    ): Promise<void> {
      return api.logEvent({
        eventType: 'authz.access.denied',
        userId,
        resourceType,
        resourceId,
        details: { reason },
        riskScore: 0.5,
      });
    },

    async logTokenCreated(
      userId: string,
      tokenType: string,
      ipAddress?: string
    ): Promise<void> {
      return api.logEvent({
        eventType: 'auth.token.created',
        userId,
        ipAddress,
        details: { tokenType },
      });
    },

    async logTokenRevoked(
      userId: string,
      tokenType: string,
      reason: string
    ): Promise<void> {
      return api.logEvent({
        eventType: 'auth.token.revoked',
        userId,
        details: { tokenType, reason },
      });
    },

    async logAnomalyDetected(
      userId: string,
      ipAddress: string,
      riskScore: number,
      anomalyFlags: string[]
    ): Promise<void> {
      return api.logEvent({
        eventType: 'security.anomaly.detected',
        userId,
        ipAddress,
        riskScore,
        anomalyFlags,
      });
    },

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

      return api.logEvent({
        eventType: eventTypeMap[operation],
        userId,
        resourceType,
        resourceId,
        details,
      });
    },

    async logLogout(
      userId: string,
      sessionId: string,
      ipAddress?: string
    ): Promise<void> {
      return api.logEvent({
        eventType: 'auth.logout',
        userId,
        sessionId,
        ipAddress,
      });
    },

    async logRateLimited(
      ipAddress: string,
      endpoint: string,
      userId?: string
    ): Promise<void> {
      return api.logEvent({
        eventType: 'security.rate.limited',
        userId,
        ipAddress,
        details: { endpoint },
        riskScore: 0.4,
      });
    },

    async logBruteForceDetected(
      ipAddress: string,
      attemptCount: number,
      targetUser?: string
    ): Promise<void> {
      return api.logEvent({
        eventType: 'security.brute.force.detected',
        ipAddress,
        details: { attemptCount, targetUser },
        riskScore: 0.8,
        anomalyFlags: ['brute_force'],
      });
    },

    async queryEvents(options: QueryEventsOptions): Promise<SelectSecurityAuditLog[]> {
      return queryAuditEvents(options);
    },
  };

  return api;
}

/**
 * Lazily build the default repository instance. Deferred (rather than built
 * eagerly at module load) so module load order between security-audit.ts
 * and security-audit-repository.ts never matters.
 */
let defaultRepository: SecurityAuditRepository | null = null;
function getDefaultRepository(): SecurityAuditRepository {
  if (!defaultRepository) {
    defaultRepository = createSecurityAuditRepository({ db });
  }
  return defaultRepository;
}

let defaultService: SecurityAuditService | null = null;
function getDefaultService(): SecurityAuditService {
  if (!defaultService) {
    defaultService = createSecurityAuditService({ repository: getDefaultRepository() });
  }
  return defaultService;
}

/**
 * Singleton instance for application-wide use.
 * Call securityAudit.initialize() during app startup.
 */
export const securityAudit: SecurityAuditService = {
  initialize: () => getDefaultService().initialize(),
  isInitialized: () => getDefaultService().isInitialized(),
  logEvent: (event) => getDefaultService().logEvent(event),
  logAuthSuccess: (...args) => getDefaultService().logAuthSuccess(...args),
  logAuthFailure: (...args) => getDefaultService().logAuthFailure(...args),
  logAccessDenied: (...args) => getDefaultService().logAccessDenied(...args),
  logTokenCreated: (...args) => getDefaultService().logTokenCreated(...args),
  logTokenRevoked: (...args) => getDefaultService().logTokenRevoked(...args),
  logAnomalyDetected: (...args) => getDefaultService().logAnomalyDetected(...args),
  logDataAccess: (...args) => getDefaultService().logDataAccess(...args),
  logLogout: (...args) => getDefaultService().logLogout(...args),
  logRateLimited: (...args) => getDefaultService().logRateLimited(...args),
  logBruteForceDetected: (...args) => getDefaultService().logBruteForceDetected(...args),
  queryEvents: (options) => getDefaultService().queryEvents(options),
};
