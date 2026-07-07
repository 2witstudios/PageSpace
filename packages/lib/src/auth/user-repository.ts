/**
 * Encryption-aware user repository edge (GDPR #965 — live call-site cutover).
 *
 * The single seam through which the running app reads, writes, and matches users
 * by email once PII encryption is rolling out. It makes the SAFETY INVARIANT from
 * docs/security/pii-encryption-design.md concrete:
 *
 *  1. READ  — resolve a user by `emailBidx = blindIndex(email)` FIRST, falling
 *     back to the legacy `eq(users.email, plaintext)` match. `decryptField`
 *     tolerates ciphertext AND legacy plaintext, so a database in mixed state
 *     (some rows encrypted, some not) reads correctly.
 *  2. WRITE — on create/update ALWAYS set `emailBidx` (deterministic, derived
 *     from the normalized plaintext) whenever a key is configured, so lookups
 *     work even before a row's `email` value is encrypted. Encrypt `email`/`name`
 *     only once the ciphertext flag is on (staged rollout).
 *  3. The raw `email` unique constraint stays for now — `emailBidx` is the new
 *     lookup key but retiring the raw constraint is a LATER step.
 *
 * Behaviour is byte-identical to today when no `ENCRYPTION_KEY` is configured.
 *
 * Mirrors the proven `audit-ip-crypto` + `audit-query` wiring. Pure decision
 * functions take the index key / flag explicitly; the env-bound wrappers read
 * `ENCRYPTION_KEY` / `PII_ENCRYPTION_ENABLED`.
 */
import { db } from '@pagespace/db/db';
import { eq, or, inArray, sql, type SQL } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { deriveIndexKey, emailBlindIndex, normalizeEmail } from '../encryption/blind-index';
import { encryptField, decryptField } from '../encryption/field-crypto';

const MIN_MASTER_KEY_LENGTH = 32;

type UserRow = typeof users.$inferSelect;

/**
 * Derive the PII blind-index key from `ENCRYPTION_KEY`, or `null` when no usable
 * key is configured. `null` ⇒ behaviour is byte-identical to today: raw-email
 * lookups, no blind index, plaintext values.
 */
export function getUserIndexKey(): Buffer | null {
  const master = process.env.ENCRYPTION_KEY ?? '';
  return master.length >= MIN_MASTER_KEY_LENGTH ? deriveIndexKey(master) : null;
}

/**
 * Whether NEW writes should store AES-GCM ciphertext for `email`/`name`. Gated
 * behind BOTH a configured key and the explicit `PII_ENCRYPTION_ENABLED` flag so
 * ciphertext writes can be staged independently of the (always-on once keyed)
 * blind-index write + dual-lookup read.
 */
export function isPiiCiphertextWriteEnabled(): boolean {
  return getUserIndexKey() !== null && process.env.PII_ENCRYPTION_ENABLED === 'true';
}

// ---------------------------------------------------------------------------
// Lookup (read) — dual lookup
// ---------------------------------------------------------------------------

export interface UserEmailLookupTargets {
  /** Blind index of the normalized email, or `null` when no key is configured. */
  emailBidx: string | null;
  /** Raw email value for the legacy-plaintext fallback (preserved verbatim). */
  email: string;
}

/** Pure: what a single-email lookup should match. */
export function userEmailLookupTargets(email: string, key: Buffer | null): UserEmailLookupTargets {
  return {
    emailBidx: key ? emailBlindIndex(email, key) : null,
    email,
  };
}

/**
 * Pure Drizzle condition for a user-by-email lookup. With a key, matches the
 * blind index OR the legacy raw email (dual lookup); without, the raw email only.
 * Drop-in for any `eq(users.email, x)` — composes inside `and(...)`.
 */
export function buildUserEmailMatch(email: string, key: Buffer | null): SQL {
  const targets = userEmailLookupTargets(email, key);
  if (targets.emailBidx === null) {
    return eq(users.email, targets.email);
  }
  return or(eq(users.emailBidx, targets.emailBidx), eq(users.email, targets.email))!;
}

/** Env-bound user-by-email match (dual lookup whenever a key is configured). */
export function userEmailMatch(email: string): SQL {
  return buildUserEmailMatch(email, getUserIndexKey());
}

export interface UserInListLookupTargets {
  /** Blind indexes of the normalized emails, or `null` when no key is configured. */
  emailBidxList: string[] | null;
  /** Lowercased emails for the legacy `lower(email) IN (...)` fallback. */
  emailListLower: string[];
}

/** Pure: what an IN-list email lookup should match (calendar sync). */
export function userInListLookupTargets(emails: string[], key: Buffer | null): UserInListLookupTargets {
  return {
    emailBidxList: key ? emails.map((e) => emailBlindIndex(e, key)) : null,
    emailListLower: emails.map((e) => normalizeEmail(e)),
  };
}

/**
 * Pure Drizzle condition for an IN-list user-by-email lookup. With a key, matches
 * the blind-index list OR the lowercased raw-email list; without, the raw list.
 */
export function buildUserEmailInListMatch(emails: string[], key: Buffer | null): SQL {
  const targets = userInListLookupTargets(emails, key);
  const lowerMatch = inArray(sql`lower(${users.email})`, targets.emailListLower);
  if (targets.emailBidxList === null) {
    return lowerMatch;
  }
  return or(inArray(users.emailBidx, targets.emailBidxList), lowerMatch)!;
}

/** Env-bound IN-list user-by-email match. */
export function userEmailInListMatch(emails: string[]): SQL {
  return buildUserEmailInListMatch(emails, getUserIndexKey());
}

// ---------------------------------------------------------------------------
// Write — emailBidx always (when keyed); ciphertext gated by flag
// ---------------------------------------------------------------------------

type WriteFields = {
  email?: string | null;
  name?: string | null;
};

/**
 * Pure-ish: transform an insert/update `values` object so `email`/`name` are
 * stored per the rollout state, and `emailBidx` is (re)computed whenever an email
 * is present and a key is configured. Unrelated fields pass through untouched.
 *
 * @param values    the object handed to `db.insert(...).values()` / `.set()`.
 * @param key       blind-index key, or `null` for the no-key (today) path.
 * @param ciphertext whether to AES-GCM the values (vs. staged plaintext + bidx).
 */
export async function encryptUserWriteFields<T extends WriteFields>(
  values: T,
  key: Buffer | null,
  ciphertext: boolean,
): Promise<T & { emailBidx?: string }> {
  const out = { ...values } as T & { emailBidx?: string };

  if (ciphertext) {
    if (typeof out.email === 'string') out.email = await encryptField(out.email);
    if (typeof out.name === 'string') out.name = await encryptField(out.name);
  }

  if (key && typeof values.email === 'string') {
    out.emailBidx = emailBlindIndex(values.email, key);
  }

  return out;
}

/**
 * Env-bound write preparer for any user insert/update `values`. Adds `emailBidx`
 * and (when enabled) ciphertext. Use at every user CREATE and any email/name
 * UPDATE site so persisted rows are encryption-aware.
 */
export async function prepareUserWrite<T extends WriteFields>(values: T): Promise<T & { emailBidx?: string }> {
  return encryptUserWriteFields(values, getUserIndexKey(), isPiiCiphertextWriteEnabled());
}

// ---------------------------------------------------------------------------
// Read projection — decrypt at the edge
// ---------------------------------------------------------------------------

/**
 * Decrypt a row's `email`/`name` back to plaintext in place (legacy plaintext
 * passes through). Null-safe and tolerant of rows missing either field — the
 * `null`/`undefined` overload supports `leftJoin`ed user rows.
 */
type DecryptableUserRow = { email?: string | null; name?: string | null };
export async function decryptUserRow<T extends DecryptableUserRow>(row: T): Promise<T>;
export async function decryptUserRow<T extends DecryptableUserRow>(row: T | null): Promise<T | null>;
export async function decryptUserRow<T extends DecryptableUserRow>(
  row: T | null | undefined,
): Promise<T | null | undefined>;
export async function decryptUserRow<T extends DecryptableUserRow>(
  row: T | null | undefined,
): Promise<T | null | undefined> {
  if (row === null || row === undefined) return row;
  const out: DecryptableUserRow = { ...row };
  if (typeof out.email === 'string') out.email = await decryptField(out.email);
  if (typeof out.name === 'string') out.name = await decryptField(out.name);
  return out as T;
}

/** Decrypt an array of user rows (null entries preserved). */
export async function decryptUserRows<T extends { email?: string | null; name?: string | null }>(
  rows: T[],
): Promise<T[]> {
  return Promise.all(rows.map((r) => decryptUserRow(r)));
}

/**
 * Decrypt each row's PII exactly once per unique `id`, even when the same
 * user appears on many rows (e.g. one actor across dozens of activity rows).
 * Returns a map from id to the decrypted row; null/undefined entries are
 * skipped. Callers re-attach the decrypted row to each original row by id.
 */
export async function decryptUsersByIdOnce<T extends DecryptableUserRow & { id: string }>(
  rows: ReadonlyArray<T | null | undefined>,
): Promise<Map<string, T>> {
  const uniqueById = new Map<string, T>();
  for (const row of rows) {
    if (row && !uniqueById.has(row.id)) {
      uniqueById.set(row.id, row);
    }
  }

  const decrypted = await Promise.all(
    Array.from(uniqueById.entries()).map(async ([id, row]) => [id, await decryptUserRow(row)] as const),
  );

  return new Map(decrypted);
}

// ---------------------------------------------------------------------------
// Convenience full-row lookup
// ---------------------------------------------------------------------------

/**
 * Find a user by email via dual lookup, returning the row with `email`/`name`
 * decrypted to plaintext (or `null`). Convenience for the simple lookup sites.
 */
export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const row = await db.query.users.findFirst({ where: userEmailMatch(email) });
  return row ? decryptUserRow(row) : null;
}
