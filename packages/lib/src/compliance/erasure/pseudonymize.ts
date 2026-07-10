/**
 * Art 17(3)(b) pseudonymization patches for the append-only audit tables — #985.
 *
 * Row deletion is forbidden on these tables: it would break the tamper-evident
 * hash chain that justifies their retention under the legal-obligation
 * exemption. Instead, a disputed Art 17 request is answered by overwriting ONLY
 * the denormalized actor PII columns — never a hash-chained or content field.
 *
 * These functions are pure: they return the exact column patch plus the set of
 * fields the hash chain depends on, so the safety guard can prove the patch can
 * never disturb the chain.
 */

/** Replacement value for the activity-log denormalized actor email. */
export const PSEUDONYM_EMAIL = 'erased@pseudonymized';

/**
 * Columns that feed the activity-log hash chain (the serialized hash inputs
 * plus the stored chain columns). The patch must avoid every one of these.
 */
export const ACTIVITY_LOG_HASHED_FIELDS: ReadonlySet<string> = new Set([
  // Hash inputs (serializeLogDataForHash)
  'id',
  'timestamp',
  'operation',
  'resourceType',
  'resourceId',
  'driveId',
  'pageId',
  'contentSnapshot',
  'previousValues',
  'newValues',
  'metadata',
  // Stored chain columns
  'previousLogHash',
  'logHash',
  'chainSeed',
  'chainSeq',
]);

/** Columns that feed the security-audit hash chain. */
export const SECURITY_AUDIT_HASHED_FIELDS: ReadonlySet<string> = new Set([
  // Hash inputs (computeSecurityEventHash)
  'eventType',
  'serviceId',
  'resourceType',
  'resourceId',
  'details',
  'riskScore',
  'anomalyFlags',
  'timestamp',
  'previousHash',
  // Stored chain columns
  'eventHash',
  'chainSeq',
]);

export interface ActivityLogPseudonymPatch {
  actorEmail: string;
  actorDisplayName: null;
  resourceTitle: null;
}

export interface SecurityAuditPseudonymPatch {
  ipAddress: null;
  /**
   * ip_bidx is the deterministic blind index over ip_address (equality
   * forensics). It is derived FROM the erased PII, so it must be nulled with
   * it — otherwise the subject's IP stays linkable by blind-index equality.
   * It is inside the eraser role's 6-column UPDATE scope (#890 Phase 1).
   */
  ipBidx: null;
  userAgent: null;
  geoLocation: null;
  sessionId: null;
}

export function buildActivityLogPseudonymizationPatch(): ActivityLogPseudonymPatch {
  // resourceTitle can also carry the subject's own PII (e.g. their email on an
  // account_delete row — #541) and, like actorEmail/actorDisplayName, is a
  // denormalized non-hash-input column, so it's safe and necessary to clear here too.
  return { actorEmail: PSEUDONYM_EMAIL, actorDisplayName: null, resourceTitle: null };
}

export function buildSecurityAuditPseudonymizationPatch(): SecurityAuditPseudonymPatch {
  return { ipAddress: null, ipBidx: null, userAgent: null, geoLocation: null, sessionId: null };
}

/**
 * Guard: a pseudonymization patch must touch NONE of the hash-chained columns.
 * Throws loudly if it does — wired before every UPDATE so a future careless edit
 * to a patch cannot silently corrupt the chain.
 */
export function assertPseudonymizationPatchSafe(
  patch: object,
  hashedFields: ReadonlySet<string>
): void {
  const offending = Object.keys(patch).filter((key) => hashedFields.has(key));
  if (offending.length > 0) {
    throw new Error(
      `Pseudonymization patch would mutate hash-chain field(s): ${offending.join(', ')}. ` +
        'This is forbidden — it would break the tamper-evident audit chain.'
    );
  }
}
