/**
 * Pure planner for the user-PII encryption backfill (GDPR #965).
 *
 * The imperative runner (scripts/backfill-user-pii-encryption.ts) streams rows
 * in batches and applies the update this planner returns. Keeping the decision
 * pure makes idempotency and the blind-index-from-plaintext invariant testable
 * without a database.
 */
import { encryptUserPii } from './user-crypto';
import { looksEncrypted } from './field-crypto';

export interface UserPiiRow {
  id: string;
  email: string;
  name: string;
  emailBidx: string | null;
}

export interface UserPiiBackfillUpdate {
  id: string;
  email: string;
  name: string;
  emailBidx: string;
}

/**
 * Plan the backfill update for one row, or `null` to skip.
 *
 * Acts only while the email is still PLAINTEXT — that is the only state from
 * which the blind index can be derived correctly and ciphertext + index written
 * atomically. Once the email is ciphertext the row is treated as done, making
 * the backfill idempotent and resumable.
 */
export async function planUserPiiBackfill(
  row: UserPiiRow,
  indexKey: Buffer,
): Promise<UserPiiBackfillUpdate | null> {
  if (looksEncrypted(row.email)) {
    return null;
  }
  const enc = await encryptUserPii({ email: row.email, name: row.name }, indexKey);
  return { id: row.id, email: enc.email, name: enc.name, emailBidx: enc.emailBidx };
}
