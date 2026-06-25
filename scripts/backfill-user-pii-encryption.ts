#!/usr/bin/env bun
/**
 * Backfill Script: encrypt existing user PII at rest (GDPR #965).
 *
 * Encrypts `users.email` and `users.name` (random AES-256-GCM) and populates the
 * deterministic `users.emailBidx` blind index used for equality lookups +
 * uniqueness. Decision rationale: docs/security/pii-encryption-design.md.
 *
 * Idempotent + resumable: the pure planner (planUserPiiBackfill) skips any row
 * whose email is already ciphertext, so re-runs converge and an interrupted run
 * picks up where it left off. The blind index is always derived from the
 * plaintext email, so each row's ciphertext + index are written atomically.
 *
 * Usage:
 *   bun scripts/backfill-user-pii-encryption.ts            # dry-run (default, safe)
 *   PII_ENCRYPTION_CUTOVER_DEPLOYED=true \
 *     bun scripts/backfill-user-pii-encryption.ts --apply  # live write
 *
 * SAFETY GATE (GDPR #965): a live run rewrites `users.email`/`users.name` to
 * ciphertext. If the app image still reads/queries plaintext email
 * (`eq(users.email, …)`), running this FIRST breaks magic-link / passkey /
 * OAuth / account email lookups and returns ciphertext in API responses. The
 * runner therefore defaults to dry-run and refuses `--apply` unless
 * `PII_ENCRYPTION_CUTOVER_DEPLOYED=true` explicitly confirms the
 * encryption-aware app (ciphertext writes + `emailBidx` lookups) is deployed.
 *
 * Requires ENCRYPTION_KEY in the environment (same key used at runtime).
 *
 * ─── Production procedure (Fly) ────────────────────────────────────────────
 * 1. Deploy migration 0171 (adds emailBidx + unique index, ip_bidx).
 * 2. Deploy the app image that reads/writes via the encryption edge.
 * 3. Run this script as a one-off machine on the migrate image with
 *    ENCRYPTION_KEY set. DO NOT run against production yourself — document only.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { db as defaultDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { eq, gt, asc } from '@pagespace/db/operators';
import { planUserPiiBackfill } from '@pagespace/lib/encryption/user-pii-backfill';
import { getPiiIndexKey } from '@pagespace/lib/encryption/user-crypto';

const BATCH_SIZE = 500;

export type BackfillResult = { encrypted: number; skipped: number };

export type BackfillMode =
  | { ok: true; dryRun: boolean }
  | { ok: false; error: string };

/**
 * Resolve the run mode. Dry-run is the default; a live write requires BOTH
 * `--apply` and explicit confirmation that the encryption-aware app is deployed,
 * so the backfill cannot break plaintext-email auth lookups by running early.
 */
export function resolveBackfillMode({
  apply,
  cutoverConfirmed,
}: {
  apply: boolean;
  cutoverConfirmed: boolean;
}): BackfillMode {
  if (!apply) return { ok: true, dryRun: true };
  if (!cutoverConfirmed) {
    return {
      ok: false,
      error:
        'Refusing live PII backfill: set PII_ENCRYPTION_CUTOVER_DEPLOYED=true only AFTER the ' +
        'encryption-aware app (email ciphertext writes + emailBidx lookups) is deployed. Running ' +
        'earlier breaks magic-link/passkey/OAuth/account email lookups. See ' +
        'docs/security/pii-encryption-design.md.',
    };
  }
  return { ok: true, dryRun: false };
}

type DbLike = Pick<typeof defaultDb, 'select' | 'update'>;

export async function backfill(
  dryRun: boolean,
  dbInstance: DbLike = defaultDb,
  indexKey: Buffer = getPiiIndexKey(),
): Promise<BackfillResult> {
  console.log(`🔐 Backfilling user PII encryption${dryRun ? ' (dry run)' : ''}...`);

  let encrypted = 0;
  let skipped = 0;
  let cursor = '';

  for (;;) {
    const batch = await (dbInstance as typeof defaultDb)
      .select({ id: users.id, email: users.email, name: users.name, emailBidx: users.emailBidx })
      .from(users)
      .where(gt(users.id, cursor))
      .orderBy(asc(users.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const row of batch) {
      const update = await planUserPiiBackfill(row, indexKey);
      if (!update) {
        skipped += 1;
        continue;
      }
      if (dryRun) {
        encrypted += 1;
        continue;
      }
      await (dbInstance as typeof defaultDb)
        .update(users)
        .set({ email: update.email, name: update.name, emailBidx: update.emailBidx })
        .where(eq(users.id, update.id));
      encrypted += 1;
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < BATCH_SIZE) break;
  }

  console.log(
    `✅ Backfill ${dryRun ? 'dry run ' : ''}complete. ${
      dryRun ? 'would encrypt' : 'encrypted'
    }: ${encrypted}, already encrypted: ${skipped}`,
  );
  return { encrypted, skipped };
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  const mode = resolveBackfillMode({
    apply: process.argv.includes('--apply'),
    cutoverConfirmed: process.env.PII_ENCRYPTION_CUTOVER_DEPLOYED === 'true',
  });
  if (!mode.ok) {
    console.error(`❌ ${mode.error}`);
    process.exit(1);
  }
  backfill(mode.dryRun)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Backfill failed:', err);
      process.exit(1);
    });
}
