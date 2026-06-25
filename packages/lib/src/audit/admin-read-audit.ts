/**
 * Privileged-admin-read audit events (#954).
 *
 * GDPR Art 32(1)(b) (integrity/confidentiality) and the accountability
 * principle require that operator access to personal data be auditable. Today
 * several admin endpoints read user PII (workspace structure, conversation /
 * AI-usage data, service-impersonated reads) without leaving an immutable
 * record. This pure builder produces the `admin.data.read` audit event — a
 * distinct event type from ordinary `data.read` so DSAR/operator reads are
 * separable in forensic queries — which the route edges hand to `auditRequest`.
 *
 * Pure: no I/O, deterministic; the imperative edge persists the event.
 */

import type { AuditEvent } from './security-audit';

export interface AdminReadInput {
  /**
   * The human admin/operator performing the read. Omit for service-token
   * (impersonation) reads, which have no human actor — set `serviceId` instead.
   */
  adminUserId?: string;
  /**
   * The service principal performing the read, for service-token / impersonation
   * paths. Recorded as the audit event's `serviceId` so the read is attributed
   * to the operator/service rather than to the impersonated subject.
   */
  serviceId?: string;
  /** Logical resource read, e.g. 'user_workspace', 'ai_conversation_stats'. */
  resourceType: string;
  /** Specific resource id, if any. Falls back to the target subject. */
  resourceId?: string;
  /** The data subject whose personal data was read, when a single subject. */
  targetUserId?: string;
  /** Categories of data accessed (e.g. ['workspace_structure', 'ai_usage']). */
  accessedDataCategories: string[];
  /**
   * Whether the admin acted as another user (service-token impersonation) —
   * a higher-risk operator access pattern flagged for review.
   */
  impersonated?: boolean;
}

/**
 * Build an immutable `admin.data.read` audit event for a privileged admin read.
 * The event captures the actor (human `userId` OR `serviceId`), the data
 * subject, what category of data was accessed, and whether it was an
 * impersonated read — so service-token reads are attributable to the service
 * and never recorded against the impersonated subject.
 */
export function buildAdminReadAuditEvent(input: AdminReadInput): AuditEvent {
  return {
    eventType: 'admin.data.read',
    userId: input.adminUserId,
    serviceId: input.serviceId,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? input.targetUserId ?? input.resourceType,
    riskScore: input.impersonated ? 0.6 : 0.5,
    anomalyFlags: input.impersonated ? ['admin_impersonation'] : undefined,
    details: {
      privilegedAdminRead: true,
      actorServiceId: input.serviceId ?? null,
      targetUserId: input.targetUserId ?? null,
      accessedDataCategories: [...input.accessedDataCategories],
      impersonated: input.impersonated ?? false,
    },
  };
}
