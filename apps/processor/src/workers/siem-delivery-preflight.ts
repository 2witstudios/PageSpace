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
  kind: 'tamper';
  source: AuditLogSource;
  entryId: string;
  breakAtIndex: number;
  breakReason: 'hash_mismatch' | 'chain_break' | 'missing_hash';
  expectedHash: string | null;
  actualHash: string | null;
}

/**
 * Distinct variant returned when preflight cannot verify the chain because a
 * DB-side dependency (cursor read, anchor load, bulk hashable load) failed.
 * Kept separate from PreflightHalt so the worker can halt delivery AND record
 * a cursor error WITHOUT firing the chain verification webhook or emitting a
 * CHAIN TAMPER DETECTED log line — a transient DB blip is not tamper, and
 * signalling it as such erodes the alert's credibility.
 */
export interface PreflightDbError {
  kind: 'db_error';
  source: AuditLogSource;
  message: string;
}

export type PreflightResult = PreflightHalt | PreflightDbError;

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
): Promise<PreflightResult | null> {
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
        // Fail closed: the anchor row pointed at by the cursor is gone.
        // This could be operational churn (pruning, GDPR erasure) OR
        // tampering — the two are indistinguishable from here, and letting
        // delivery proceed would re-anchor the cursor on newly delivered
        // rows and permanently hide any historical break. Surface as a
        // db_error so the worker halts delivery and records a cursor
        // error without firing the tamper webhook (anchor loss isn't
        // distinctively tamper, and false-paging erodes the alert's
        // credibility). Operators see the halt in /health and must
        // investigate before delivery can resume.
        return {
          kind: 'db_error',
          source,
          message: `Anchor hash missing for cursor anchor entry ${lastDeliveredId} — halting delivery fail-closed`,
        };
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
      return { kind: 'db_error', source, message };
    }

    if (!verificationResult.valid) {
      return {
        kind: 'tamper',
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
