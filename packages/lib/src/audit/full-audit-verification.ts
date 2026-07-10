/**
 * Full audit verification — chain + anchors + co-stream (#890 Phase 2,
 * leaf 5).
 *
 * The periodic verifier no longer proves only internal chain consistency:
 * a chain whose head lives in its own DB proves nothing to an attacker who
 * owns that DB. Where configured, this composite additionally
 *   - matches published anchors against the chain (matchAnchorsAgainstChain,
 *     leaf 3): tamper under a witnessed head becomes visible, and
 *   - reconciles collector-supplied co-stream records against the store
 *     (runCoStreamReconciliation, leaf 4): suppression/tamper of stored
 *     rows against the second independent record.
 *
 * Degrades explicitly, never silently: every skipped check carries a
 * skippedReason in the result, and every failed check logs a security error
 * and (for anchors) fires the alert channel.
 *
 * Anchors and co-stream exist only in the dedicated Admin PG — under
 * break-glass both checks are skipped (the legacy main-DB chain has neither
 * surface).
 */

import { desc, inArray } from 'drizzle-orm';
import { securityAuditAnchors, securityAuditLog } from '@pagespace/db/admin-schema';
import { loggers } from '../logging/logger-config';
import {
  matchAnchorsAgainstChain,
  ANCHOR_SOURCE,
  type AnchorChainMatchReport,
  type SignedAnchor,
} from './anchor';
import {
  runCoStreamReconciliation,
  type RunCoStreamReconciliationDeps,
} from './co-stream-reconciliation';
import type { CoStreamReconciliationReport, CoStreamRecord, ReconciliationWindow } from './co-stream';
import { resolveAuditDbBinding, type AuditDbBinding } from './audit-db-binding';
import {
  verifyAndAlert,
  notifyAnchorVerificationFailure,
} from './security-audit-alerting';
import type { SecurityChainVerificationResult } from './security-audit-chain-verifier';
import type { VerifySecurityChainOptions, VerifySecurityChainDeps } from './security-audit-chain-verifier';

/** Row shape of security_audit_anchors as read back for verification. */
export interface StoredAnchorRow {
  version: number;
  chainSeq: number;
  headHash: string;
  anchoredAt: Date;
  signature: string;
}

/**
 * Rebuild the SignedAnchor payload from its receipt row. Pure. The
 * signature covers the anchor's OWN fields (verifyAnchorSignature
 * recomputes from them), so a faithful column round-trip verifies and any
 * receipt tamper renders the anchor 'unverifiable'.
 */
export function anchorRowToSignedAnchor(row: StoredAnchorRow): SignedAnchor {
  return {
    version: row.version,
    source: ANCHOR_SOURCE,
    chainSeq: row.chainSeq,
    head: row.headHash,
    anchoredAt: row.anchoredAt.toISOString(),
    signature: row.signature,
  };
}

export type AnchorCheckOutcome =
  | { configured: false; skippedReason: string }
  | { configured: true; report: AnchorChainMatchReport };

export type CoStreamCheckOutcome =
  | { configured: false; skippedReason: string }
  | { configured: true; report: CoStreamReconciliationReport };

export interface FullAuditVerificationResult {
  chain: SecurityChainVerificationResult;
  anchors: AnchorCheckOutcome;
  coStream: CoStreamCheckOutcome;
  /**
   * Chain-consistency AND anchor-match AND co-stream reconciliation, each
   * counted only where configured. A skipped check never fails the run —
   * but it is reported, never hidden.
   */
  isValid: boolean;
}

/**
 * Pure verdict combination: every CONFIGURED check must pass.
 */
export function combineAuditVerdicts(result: {
  chain: Pick<SecurityChainVerificationResult, 'isValid'>;
  anchors: AnchorCheckOutcome;
  coStream: CoStreamCheckOutcome;
}): boolean {
  if (!result.chain.isValid) return false;
  if (result.anchors.configured && !result.anchors.report.allMatch) return false;
  if (result.coStream.configured && !result.coStream.report.verified) return false;
  return true;
}

export interface AnchorVerificationEnv {
  AUDIT_ANCHOR_ENABLED?: string | undefined;
  AUDIT_ANCHOR_SECRET?: string | undefined;
}

export interface RunFullAuditVerificationOptions {
  source?: 'periodic' | 'manual';
  chain?: VerifySecurityChainOptions;
  /**
   * Collector-supplied co-stream records + window. Absent → the co-stream
   * check is skipped (the web cron has no collector reader; the Phase 6
   * tamper drill and the backfill verifier pass records explicitly).
   */
  coStream?: { records: readonly CoStreamRecord[]; window: ReconciliationWindow };
  /** Most-recent anchors to verify per run (default 25). */
  anchorLimit?: number;
}

export interface RunFullAuditVerificationDeps {
  /** Anchor gating env; defaults to process.env. */
  env?: AnchorVerificationEnv;
  /** Chain verification runner; defaults to verifyAndAlert. */
  verifyChain?: (
    source: 'periodic' | 'manual',
    options?: VerifySecurityChainOptions,
    deps?: VerifySecurityChainDeps
  ) => Promise<SecurityChainVerificationResult>;
  /** Co-stream reconciliation runner; defaults to runCoStreamReconciliation. */
  reconcileCoStream?: (
    deps: RunCoStreamReconciliationDeps
  ) => Promise<CoStreamReconciliationReport>;
}

const DEFAULT_ANCHOR_LIMIT = 25;

async function checkAnchors(
  binding: AuditDbBinding,
  env: AnchorVerificationEnv,
  anchorLimit: number
): Promise<AnchorCheckOutcome> {
  if (binding.mode !== 'dedicated') {
    return {
      configured: false,
      skippedReason:
        'anchor verification requires the dedicated Admin PG — break-glass is active',
    };
  }
  if (env.AUDIT_ANCHOR_ENABLED !== 'true') {
    return { configured: false, skippedReason: 'anchoring is not enabled (AUDIT_ANCHOR_ENABLED)' };
  }
  const secret = env.AUDIT_ANCHOR_SECRET;
  if (!secret) {
    return {
      configured: false,
      skippedReason:
        'AUDIT_ANCHOR_ENABLED is true but AUDIT_ANCHOR_SECRET is unset — anchors cannot be verified',
    };
  }

  const anchorRows: StoredAnchorRow[] = await binding.db
    .select({
      version: securityAuditAnchors.version,
      chainSeq: securityAuditAnchors.chainSeq,
      headHash: securityAuditAnchors.headHash,
      anchoredAt: securityAuditAnchors.anchoredAt,
      signature: securityAuditAnchors.signature,
    })
    .from(securityAuditAnchors)
    .orderBy(desc(securityAuditAnchors.chainSeq))
    .limit(anchorLimit);

  if (anchorRows.length === 0) {
    return {
      configured: false,
      skippedReason: 'anchoring is enabled but no anchors have been published yet',
    };
  }

  const seqs = anchorRows.map((row) => row.chainSeq);
  const chainRows = await binding.db
    .select({ chainSeq: securityAuditLog.chainSeq, eventHash: securityAuditLog.eventHash })
    .from(securityAuditLog)
    .where(inArray(securityAuditLog.chainSeq, seqs));

  const chainBySeq = new Map<number, string>(
    chainRows.map((row) => [Number(row.chainSeq), row.eventHash]),
  );

  const report = matchAnchorsAgainstChain(
    anchorRows.map(anchorRowToSignedAnchor),
    chainBySeq,
    secret,
  );
  return { configured: true, report };
}

/**
 * Run the composite verification against the resolved audit binding.
 * Chain-verification alerts flow through verifyAndAlert exactly as before;
 * anchor failures additionally fire the 'anchor_verify' alert; co-stream
 * failures log a security error (their consumers own deeper handling).
 */
export async function runFullAuditVerification(
  options: RunFullAuditVerificationOptions = {},
  deps: RunFullAuditVerificationDeps = {}
): Promise<FullAuditVerificationResult> {
  const binding = resolveAuditDbBinding();
  const env: AnchorVerificationEnv = deps.env ?? {
    AUDIT_ANCHOR_ENABLED: process.env.AUDIT_ANCHOR_ENABLED,
    AUDIT_ANCHOR_SECRET: process.env.AUDIT_ANCHOR_SECRET,
  };
  const verifyChain = deps.verifyChain ?? verifyAndAlert;
  const reconcile = deps.reconcileCoStream ?? runCoStreamReconciliation;

  const chain = await verifyChain(options.source ?? 'manual', options.chain, { db: binding.db });

  const anchors = await checkAnchors(binding, env, options.anchorLimit ?? DEFAULT_ANCHOR_LIMIT);
  if (anchors.configured && !anchors.report.allMatch) {
    const firstBad = anchors.report.results.find((r) => r.verdict !== 'match');
    loggers.security.error(
      '[FullAuditVerification] Anchor-vs-chain verification FAILED — the chain disagrees with its external witness',
      { counts: anchors.report.counts, firstFailure: firstBad },
    );
    if (firstBad) {
      await notifyAnchorVerificationFailure({
        anchorsChecked: anchors.report.results.length,
        hashMismatches: anchors.report.counts.hash_mismatch,
        seqGaps: anchors.report.counts.seq_gap,
        unverifiable: anchors.report.counts.unverifiable,
        firstFailure: {
          chainSeq: firstBad.chainSeq,
          verdict: firstBad.verdict as 'hash_mismatch' | 'seq_gap' | 'unverifiable',
          anchorHead: firstBad.anchorHead,
          chainHead: firstBad.chainHead,
        },
      });
    }
  } else if (!anchors.configured) {
    loggers.security.info('[FullAuditVerification] anchor check skipped', {
      skippedReason: anchors.skippedReason,
    });
  }

  let coStream: CoStreamCheckOutcome;
  if (!options.coStream) {
    coStream = { configured: false, skippedReason: 'no collector co-stream records supplied' };
  } else if (binding.mode !== 'dedicated') {
    coStream = {
      configured: false,
      skippedReason:
        'co-stream reconciliation requires the dedicated Admin PG — break-glass is active',
    };
  } else {
    const report = await reconcile({
      records: options.coStream.records,
      db: binding.db,
      window: options.coStream.window,
    });
    coStream = { configured: true, report };
    if (!report.verified) {
      loggers.security.error(
        '[FullAuditVerification] Co-stream reconciliation FAILED — store and witness stream disagree',
        { counts: report.counts, head: report.head },
      );
    }
  }

  return {
    chain,
    anchors,
    coStream,
    isValid: combineAuditVerdicts({ chain, anchors, coStream }),
  };
}
