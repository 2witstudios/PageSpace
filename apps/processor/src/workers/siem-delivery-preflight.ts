import type { AuditLogEntry, AuditLogSource } from '../services/siem-adapter';
import {
  verifyChainForSource,
  type VerificationResult,
} from '../services/siem-chain-verifier';
import {
  recomputeActivityLogHash,
  recomputeSecurityAuditHash,
  type ActivityLogHashableFields,
  type SecurityAuditHashableFields,
} from '../services/siem-chain-hashers';
import {
  loadAnchorHash,
  loadActivityLogHashableFields,
  loadSecurityAuditHashableFields,
} from './siem-anchor-loader';
import { CURSOR_INIT_SENTINEL } from './siem-delivery-worker-constants';

/**
 * SIEM chain-verification preflight — the impure DB-facing orchestration.
 *
 * The worker calls this once per poll cycle, immediately before delivery.
 * It groups the merged batch by source, loads each source's anchor hash and
 * bulk-loads the hash-relevant subset of rows, then runs the pure verifier
 * (services/siem-chain-verifier.ts) with the matching per-source strategy
 * (services/siem-chain-hashers.ts). Returns `null` if every source verifies
 * clean, or a halt descriptor for the FIRST break encountered so the worker
 * can record a precise error on the correct cursor.
 *
 * Extracted from the worker for two reasons:
 *   1. Existing worker tests were written pre-preflight and mock the DB at
 *      query-call granularity. Having the preflight as its own module lets
 *      those tests mock the whole phase to a no-op with a single vi.mock,
 *      instead of stubbing every cursor/anchor/hashable SELECT individually.
 *   2. It keeps the worker file focused on the outer orchestration and the
 *      preflight focused on the verification data flow. Each file can be
 *      reasoned about in isolation.
 */

interface PgClient {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface PreflightHalt {
  source: AuditLogSource;
  entryId: string;
  breakAtIndex: number;
  breakReason: 'hash_mismatch' | 'chain_break' | 'missing_hash';
  expectedHash: string | null;
  actualHash: string | null;
}

const SOURCES: readonly AuditLogSource[] = ['activity_logs', 'security_audit_log'] as const;

/**
 * Run chain verification across every source represented in the merged batch.
 *
 * Contract:
 *   - Returns `null` if verification passes for every source (delivery
 *     proceeds).
 *   - Returns a PreflightHalt if any source's sub-batch fails. Sources are
 *     checked in SOURCES order so diagnostics are stable across runs.
 *   - Sources whose cursor is still at CURSOR_INIT_SENTINEL are SKIPPED —
 *     the worker never delivers a batch whose anchor hash it can't recover
 *     without also running verification against that anchor, so we trust
 *     the first batch after init and verify everything afterward.
 *   - A DB error during anchor or hashable-field load is itself treated as
 *     a halt (for the affected source) because preflight cannot proceed
 *     without the data. Halting is safe — it only blocks delivery, it
 *     doesn't lose events — whereas letting delivery proceed unverified
 *     would defeat the point of the chain.
 */
export async function runChainPreflight(
  client: PgClient,
  merged: readonly AuditLogEntry[]
): Promise<PreflightHalt | null> {
  const bySource = new Map<AuditLogSource, AuditLogEntry[]>();
  for (const source of SOURCES) {
    bySource.set(source, []);
  }
  for (const entry of merged) {
    bySource.get(entry.source)?.push(entry);
  }

  for (const source of SOURCES) {
    const entries = bySource.get(source) ?? [];
    if (entries.length === 0) continue;

    let verificationResult: VerificationResult;

    try {
      // Re-read the cursor under the advisory lock. The worker already loaded
      // it during phase 1, but re-reading is cheap and keeps preflight
      // self-contained — the alternative (passing cursor state in from the
      // worker) couples this module to the worker's internal SourceState
      // shape for no real benefit.
      const cursorResult = await client.query(
        'SELECT "lastDeliveredId" FROM siem_delivery_cursors WHERE id = $1',
        [source]
      );
      const cursorRow = cursorResult.rows[0] as
        | { lastDeliveredId: string | null }
        | undefined;
      const lastDeliveredId = cursorRow?.lastDeliveredId ?? null;

      if (lastDeliveredId === null || lastDeliveredId === CURSOR_INIT_SENTINEL) {
        // Fresh cursor — no anchor, skip this source's verification entirely.
        continue;
      }

      const anchorHash = await loadAnchorHash(client, source, lastDeliveredId);
      if (anchorHash === null) {
        // loadAnchorHash logs its own warn when the anchor row is missing.
        // Treating a missing anchor as "skip" (rather than halt) keeps
        // delivery unblocked after operational churn (pruning, erasure)
        // — the next run will pick up a real anchor from the entries we're
        // about to deliver.
        continue;
      }

      if (source === 'activity_logs') {
        const hashableMap = await loadActivityLogHashableFields(
          client,
          entries.map((e) => e.id)
        );
        verificationResult = verifyChainForSource({
          anchorHash,
          entries,
          recomputeHash: (entry, previousHash) => {
            const data = hashableMap.get(entry.id) as
              | ActivityLogHashableFields
              | undefined;
            if (!data) {
              // Present in the merged batch but absent from the bulk load:
              // the row was deleted between initial SELECT and preflight.
              // Can't verify — throw to halt the whole run safely.
              throw new Error(
                `Hashable fields missing for activity_logs entry ${entry.id}`
              );
            }
            return recomputeActivityLogHash(data, previousHash);
          },
        });
      } else {
        const hashableMap = await loadSecurityAuditHashableFields(
          client,
          entries.map((e) => e.id)
        );
        verificationResult = verifyChainForSource({
          anchorHash,
          entries,
          recomputeHash: (entry, previousHash) => {
            const data = hashableMap.get(entry.id) as
              | SecurityAuditHashableFields
              | undefined;
            if (!data) {
              throw new Error(
                `Hashable fields missing for security_audit_log entry ${entry.id}`
              );
            }
            return recomputeSecurityAuditHash(data, previousHash);
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        source,
        entryId: entries[0]?.id ?? 'unknown',
        breakAtIndex: 0,
        breakReason: 'missing_hash',
        expectedHash: null,
        actualHash: message,
      };
    }

    if (!verificationResult.valid) {
      return {
        source,
        entryId: entries[verificationResult.breakAtIndex].id,
        breakAtIndex: verificationResult.breakAtIndex,
        breakReason: verificationResult.breakReason,
        expectedHash: verificationResult.expectedHash,
        actualHash: verificationResult.actualHash,
      };
    }
  }

  return null;
}
