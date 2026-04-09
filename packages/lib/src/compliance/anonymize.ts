import { createHash } from 'crypto';

/**
 * Create an anonymized identifier for GDPR-compliant audit trail preservation.
 * Uses a deterministic hash so the same user ID always produces the same anonymized ID.
 */
export function createAnonymizedActorEmail(userId: string): string {
  const hash = createHash('sha256').update(userId).digest('hex').slice(0, 12);
  return `deleted_user_${hash}`;
}
