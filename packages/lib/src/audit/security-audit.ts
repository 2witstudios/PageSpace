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
 * Concurrency (#890 Phase 2, leaf 5 cutover): with a dedicated Admin PG,
 * logEvent() is LOCK-FREE — pure emission hash + one INSERT into the ingest
 * queue; the single-writer chainer assigns chain_seq/chainHash out of band.
 * Under break-glass only, the legacy pg_advisory_xact_lock append against
 * the main DB remains, with the previous hash read inside the lock.
 */

import { createHash } from 'crypto';
import type { SecurityEventType, SelectSecurityAuditLog } from '@pagespace/db/schema/security-audit';
import { queryAuditEvents } from './audit-query';
import { stableStringify } from '../utils/stable-stringify';
import {
  createSecurityAuditRepository,
  type AppendEventOptions,
} from './security-audit-repository';
import { createAuditIngestWriter } from './audit-ingest-writer';
import { resolveAuditDbBinding, type AuditDbBinding } from './audit-db-binding';
import { notifyAdminDbBreakGlass } from './security-audit-alerting';
import { loggers } from '../logging/logger-config';

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
 * Advisory lock key for serializing hash chain writes. Re-exported from the
 * repository (single source of truth) under the name existing tests expect.
 */
export { SECURITY_AUDIT_CHAIN_LOCK_KEY as CHAIN_LOCK_KEY } from './security-audit-repository';

/**
 * The one write capability the service needs. Satisfied by BOTH append
 * backends of the cutover (#890 Phase 2, leaf 5): the legacy advisory-lock
 * repository (SecurityAuditRepository) and the lock-free ingest writer
 * adapter built in getDefaultAppendPath().
 */
export interface AuditAppendPath {
  appendEvent(event: AuditEvent, opts?: AppendEventOptions): Promise<void>;
}

export interface SecurityAuditServiceDeps {
  repository: AuditAppendPath;
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
 * Break-glass append path (#890 Phase 2, leaf 5 + folded break-glass
 * observability task): the OLD advisory-lock chained append against the
 * main DB, made LOUD at the moment it is chosen. Emitted exactly once per
 * process, at the resolved-mode call site:
 *   1. a structured security-category error (the log-plane banner),
 *   2. a real alert through the security-audit-alerting channel,
 *   3. a self-recorded security event in the (degraded) chain itself, so
 *      the degrade is visible in forensic queries and SIEM deliveries.
 * The event goes through the repository directly — not audit() — so the
 * emission can never recurse into this bind point.
 */
function buildBreakGlassAppendPath(binding: Extract<AuditDbBinding, { mode: 'break-glass' }>): AuditAppendPath {
  const repository = createSecurityAuditRepository({ db: binding.db });

  loggers.security.error(
    '[SecurityAudit] ADMIN DB BREAK-GLASS ACTIVE — audit writes are degraded to the main application database',
    { reason: binding.reason },
  );

  void notifyAdminDbBreakGlass({ reason: binding.reason });

  repository
    .appendEvent({
      eventType: 'security.suspicious.activity',
      serviceId: 'security-audit',
      resourceType: 'trust_plane',
      resourceId: 'admin_db',
      riskScore: 0.9,
      anomalyFlags: ['admin_db_break_glass'],
      details: { breakGlass: true, reason: binding.reason },
    })
    .catch((error: unknown) => {
      loggers.security.error('[SecurityAudit] failed to record the break-glass security event', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });

  return repository;
}

/**
 * Lazily resolve the default append path (#890 Phase 2, leaf 5 cutover).
 * Deferred (rather than built eagerly at module load) so module load order
 * never matters and env is read after late-loaded dotenv.
 *
 *   dedicated   → lock-free ingest writer on the Admin PG: pure emission
 *                 hash + ONE INSERT, no advisory lock, no head read, no
 *                 transaction. Chaining belongs to the single-writer
 *                 chainer worker.
 *   break-glass → the legacy chained append against the main DB, with loud
 *                 observability (see buildBreakGlassAppendPath).
 *   fail        → resolveAuditDbBinding throws; logEvent rejects per event
 *                 and the audit() wrapper surfaces it as a warn log.
 */
let defaultAppendPath: AuditAppendPath | null = null;
function getDefaultAppendPath(): AuditAppendPath {
  if (!defaultAppendPath) {
    const binding = resolveAuditDbBinding();
    if (binding.mode === 'dedicated') {
      const writer = createAuditIngestWriter({ db: binding.db });
      defaultAppendPath = {
        appendEvent: (event, opts) => writer.writeToIngest(event, opts),
      };
    } else {
      defaultAppendPath = buildBreakGlassAppendPath(binding);
    }
  }
  return defaultAppendPath;
}

/**
 * Lazy async proxy over the resolved append path. Resolution happens INSIDE
 * the async appendEvent so a fail-mode throw becomes a rejection — the
 * fire-and-forget audit() wrapper attaches .catch() and must never see a
 * synchronous throw from logEvent.
 */
const lazyDefaultAppendPath: AuditAppendPath = {
  appendEvent: async (event, opts) => getDefaultAppendPath().appendEvent(event, opts),
};

let defaultService: SecurityAuditService | null = null;
function getDefaultService(): SecurityAuditService {
  if (!defaultService) {
    defaultService = createSecurityAuditService({ repository: lazyDefaultAppendPath });
  }
  return defaultService;
}

/**
 * Test hook: drop the cached default append path + service so a test can
 * re-resolve under a different admin-db mode (pair with
 * resetAuditDbBindingForTests).
 */
export function resetDefaultSecurityAuditForTests(): void {
  defaultAppendPath = null;
  defaultService = null;
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
