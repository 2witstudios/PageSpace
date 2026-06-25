/**
 * Art 30 record-of-processing classifier (#980).
 *
 * GDPR Art 30(1) requires the controller to maintain a record of processing
 * activities including, per record: the categories of personal data, the
 * categories of recipients, the envisaged retention period, and (read together
 * with Art 5/6) the lawful basis. Our activity log is the per-event substrate
 * for that record, but historically carried none of these fields.
 *
 * This pure function maps an activity (operation + resourceType) to its
 * record-of-processing classification so the activity-log write edge can stamp
 * each row. It is deterministic and side-effect-free; inputs are loosely typed
 * (strings) to keep it decoupled from the activity-logger enums and free of an
 * import cycle, and any unmapped pair falls back to a defined `unclassified`
 * record rather than throwing.
 */

export type Art30DataCategory =
  | 'content'
  | 'identity'
  | 'access_control'
  | 'authentication'
  | 'configuration'
  | 'unclassified';

export type Art30LegalBasis =
  | 'contract'
  | 'legitimate_interest'
  | 'legal_obligation'
  | 'consent'
  | 'unclassified';

export interface Art30Record {
  /** Category of personal data processed (Art 30(1)(c)). */
  dataCategory: Art30DataCategory;
  /** Lawful basis for processing (Art 6, surfaced for the record). */
  legalBasis: Art30LegalBasis;
  /** Envisaged retention policy reference (Art 30(1)(f)). */
  retentionPolicy: string;
  /** Categories of recipients (Art 30(1)(d)). */
  recipients: string[];
}

/** Retention policy references (human/policy-readable, not literal durations). */
const RETENTION_ACCOUNT_LIFETIME = 'account_lifetime';
const RETENTION_SECURITY_LOG = 'security_log_retention';

/** Recipient categories. */
const RECIPIENT_INTERNAL = 'internal';
const RECIPIENT_STORAGE_SUBPROCESSOR = 'storage_subprocessor';

/** The defined fallback for an unmapped (operation, resourceType). */
export const UNCLASSIFIED_RECORD: Art30Record = {
  dataCategory: 'unclassified',
  legalBasis: 'unclassified',
  retentionPolicy: RETENTION_ACCOUNT_LIFETIME,
  recipients: [RECIPIENT_INTERNAL],
};

/** resourceType → data category + recipient categories. */
const RESOURCE_CATEGORY: Record<string, { dataCategory: Art30DataCategory; recipients: string[] }> = {
  page: { dataCategory: 'content', recipients: [RECIPIENT_INTERNAL] },
  drive: { dataCategory: 'content', recipients: [RECIPIENT_INTERNAL] },
  message: { dataCategory: 'content', recipients: [RECIPIENT_INTERNAL] },
  conversation: { dataCategory: 'content', recipients: [RECIPIENT_INTERNAL] },
  file: { dataCategory: 'content', recipients: [RECIPIENT_INTERNAL, RECIPIENT_STORAGE_SUBPROCESSOR] },
  user: { dataCategory: 'identity', recipients: [RECIPIENT_INTERNAL] },
  member: { dataCategory: 'access_control', recipients: [RECIPIENT_INTERNAL] },
  permission: { dataCategory: 'access_control', recipients: [RECIPIENT_INTERNAL] },
  role: { dataCategory: 'access_control', recipients: [RECIPIENT_INTERNAL] },
  token: { dataCategory: 'authentication', recipients: [RECIPIENT_INTERNAL] },
  device: { dataCategory: 'authentication', recipients: [RECIPIENT_INTERNAL] },
  agent: { dataCategory: 'configuration', recipients: [RECIPIENT_INTERNAL] },
};

/**
 * Security/account operations rest on legitimate interest (Art 6(1)(f)) rather
 * than contract — security logging and authentication-event keeping protect the
 * account independently of service delivery.
 */
const SECURITY_OPERATIONS = new Set<string>([
  'login',
  'logout',
  'signup',
  'email_change',
  'token_create',
  'token_revoke',
  'account_delete',
]);

/**
 * Classify an activity for the Art 30 record of processing.
 *
 * @param operation - the activity operation (e.g. 'create', 'login')
 * @param resourceType - the resource type (e.g. 'page', 'user')
 * @returns a fully-populated Art30Record; UNCLASSIFIED_RECORD for unmapped pairs
 */
export function classifyProcessing(operation: string, resourceType: string): Art30Record {
  const resource = RESOURCE_CATEGORY[resourceType];
  if (!resource) {
    return { ...UNCLASSIFIED_RECORD, recipients: [...UNCLASSIFIED_RECORD.recipients] };
  }

  const isSecurity = SECURITY_OPERATIONS.has(operation);

  return {
    dataCategory: resource.dataCategory,
    legalBasis: isSecurity ? 'legitimate_interest' : 'contract',
    retentionPolicy: resource.dataCategory === 'authentication' || isSecurity
      ? RETENTION_SECURITY_LOG
      : RETENTION_ACCOUNT_LIFETIME,
    recipients: [...resource.recipients],
  };
}
