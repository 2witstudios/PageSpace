#!/usr/bin/env bun
/**
 * Backfill Script: re-encrypt legacy-format user PII ciphertext to the fast format.
 *
 * The 2026-07-06 user-PII backfill (scripts/backfill-user-pii-encryption.ts)
 * ran a day BEFORE #1930 memoized the master-key derivation, so every existing
 * row's `users.email`/`users.name` is stored in the legacy 4-part
 * `salt:iv:authTag:ciphertext` envelope. Decrypting that format costs a full
 * per-record scrypt (`deriveLegacyKey`) on every read — the source of the
 * sustained post-rollout latency on the single-vCPU web machine. This script
 * decrypts each legacy value and re-encrypts it under the memoized master key
 * as the fast 3-part `iv:authTag:ciphertext` envelope. Plaintext is unchanged,
 * so `users.emailBidx` (derived from plaintext) is untouched.
 *
 * Idempotent + resumable: the pure planner (planLegacyCiphertextReencrypt)
 * skips any value already in the fast format (and never touches plaintext), so
 * re-runs converge to zero work and an interrupted run picks up where it left
 * off via the ascending-id cursor. Per-row failures are counted and logged
 * without aborting the run.
 *
 * Usage:
 *   bun scripts/backfill-legacy-ciphertext-reencrypt.ts            # dry-run (default, safe)
 *   LEGACY_CIPHERTEXT_REENCRYPT_CONFIRMED=true \
 *     bun scripts/backfill-legacy-ciphertext-reencrypt.ts --apply  # live write
 *
 * SAFETY GATE: a live run rewrites ciphertext into the 3-part envelope, which
 * only app images carrying #1930/#1931 can parse — a pre-#1930 reader throws
 * "Invalid encrypted text format" on every converted row. The runner therefore
 * defaults to dry-run and refuses `--apply` unless
 * `LEGACY_CIPHERTEXT_REENCRYPT_CONFIRMED=true` explicitly confirms every
 * reader of these columns (web, realtime, processor) is deployed on a
 * fast-format-aware image.
 *
 * Requires ENCRYPTION_KEY in the environment (same key used at runtime).
 *
 * ─── Production procedure (Fly) ────────────────────────────────────────────
 * 1. Verify web, realtime, and processor are all deployed at or after
 *    #1930 (c6e60f97f) + #1931 (da3514c7f).
 * 2. Dry-run as a one-off machine with ENCRYPTION_KEY set; sanity-check the
 *    reported legacy count (~224 users expected).
 * 3. Re-run with --apply and LEGACY_CIPHERTEXT_REENCRYPT_CONFIRMED=true.
 *    DO NOT run against production yourself — document only.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { db as defaultDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { eq, gt, asc, and } from '@pagespace/db/operators';
import { planLegacyCiphertextReencrypt } from '@pagespace/lib/encryption/legacy-ciphertext-reencrypt';

const BATCH_SIZE = 500;

export type ReencryptResult = {
  legacyFound: number;
  converted: number;
  skipped: number;
  errors: number;
};

export type ReencryptMode =
  | { ok: true; dryRun: boolean }
  | { ok: false; error: string };

/**
 * Resolve the run mode. Dry-run is the default; a live write requires BOTH
 * `--apply` and explicit confirmation that every reader can parse the fast
 * 3-part envelope, so the backfill cannot strand ciphertext that a
 * pre-#1930 app image still in production would fail to decrypt.
 */
export function resolveReencryptMode({
  apply,
  reencryptConfirmed,
}: {
  apply: boolean;
  reencryptConfirmed: boolean;
}): ReencryptMode {
  if (!apply) return { ok: true, dryRun: true };
  if (!reencryptConfirmed) {
    return {
      ok: false,
      error:
        'Refusing live legacy-ciphertext re-encryption: set LEGACY_CIPHERTEXT_REENCRYPT_CONFIRMED=true ' +
        'only AFTER every reader of users.email/users.name (web, realtime, processor) is deployed on an ' +
        'image carrying #1930/#1931 (fast iv:authTag:ciphertext envelope support). A pre-#1930 reader ' +
        'cannot parse the converted rows. See docs/security/pii-encryption-design.md.',
    };
  }
  return { ok: true, dryRun: false };
}

type DbLike = Pick<typeof defaultDb, 'select' | 'update'>;

export async function backfill(
  dryRun: boolean,
  dbInstance: DbLike = defaultDb,
  batchSize: number = BATCH_SIZE,
): Promise<ReencryptResult> {
  console.log(`🔐 Re-encrypting legacy-format user PII${dryRun ? ' (dry run)' : ''}...`);

  let converted = 0;
  let skipped = 0;
  let errors = 0;
  let cursor = '';

  for (;;) {
    const batch = await (dbInstance as typeof defaultDb)
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(gt(users.id, cursor))
      .orderBy(asc(users.id))
      .limit(batchSize);

    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        const update = await planLegacyCiphertextReencrypt(row);
        if (!update) {
          skipped += 1;
          continue;
        }
        if (dryRun) {
          converted += 1;
          continue;
        }
        // Compare-and-swap: the app can rewrite email/name (and emailBidx)
        // between the batch select and this write. Guarding on the exact
        // ciphertext read means a concurrently-modified row matches 0 rows
        // instead of being clobbered back to stale values — which would
        // desync users.email from the app-written emailBidx and break
        // blind-index login lookups. A re-run picks the row up as-is.
        const written = await (dbInstance as typeof defaultDb)
          .update(users)
          .set({ email: update.email, name: update.name })
          .where(and(eq(users.id, update.id), eq(users.email, row.email), eq(users.name, row.name)));
        if (written.rowCount === 0) {
          skipped += 1;
          console.warn(`  ⏭ row ${row.id}: modified concurrently, skipped — a re-run will convert it`);
          continue;
        }
        converted += 1;
      } catch (err) {
        // The planner only runs crypto (and the runner only writes) for
        // legacy-format rows, so every failure here is a legacy row.
        errors += 1;
        console.error(`  ⚠️ row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < batchSize) break;
  }

  const legacyFound = converted + errors;
  console.log(
    `✅ Re-encryption ${dryRun ? 'dry run ' : ''}complete. legacy found: ${legacyFound}, ${
      dryRun ? 'would convert' : 'converted'
    }: ${converted}, already fast/plaintext: ${skipped}, errors: ${errors}`,
  );
  return { legacyFound, converted, skipped, errors };
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  const mode = resolveReencryptMode({
    apply: process.argv.includes('--apply'),
    reencryptConfirmed: process.env.LEGACY_CIPHERTEXT_REENCRYPT_CONFIRMED === 'true',
  });
  if (!mode.ok) {
    console.error(`❌ ${mode.error}`);
    process.exit(1);
  }
  backfill(mode.dryRun)
    .then((result) => process.exit(result.errors > 0 ? 1 : 0))
    .catch((err) => {
      console.error('❌ Re-encryption backfill failed:', err);
      process.exit(1);
    });
}
