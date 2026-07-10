import { withAdminAuth } from '@/lib/auth';
import { z } from 'zod';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  pseudonymizeActivityLogsForUser,
  pseudonymizeSecurityAuditLogForUser,
} from '@pagespace/lib/compliance/erasure/pseudonymize-repository';
import { resolveSecurityAuditErasureTargets } from '@pagespace/lib/compliance/erasure/pseudonymize-targets';
import { verifyHashChain } from '@pagespace/lib/monitoring/hash-chain-verifier';
import { verifySecurityAuditChain } from '@pagespace/lib/audit/security-audit-chain-verifier';
import { securityAudit } from '@pagespace/lib/audit/security-audit';

/**
 * Art 17(3)(b) audit-log pseudonymization (#985, #890 Phase 2 leaf 6).
 *
 * The escalation path for a supervisory authority that disputes the retention
 * of `activity_logs` / `security_audit_log` under the legal-obligation
 * exemption. It overwrites ONLY the denormalized actor PII (never hash-chain
 * or content fields), verifies the tamper-evident chain before AND after
 * (failing loudly if the chain breaks), and self-audits the operation. Row
 * deletion is intentionally NOT offered — it would break the chain.
 *
 * Post-cutover, a subject's security-audit PII may be SPLIT across the Admin
 * PG (new chained rows, updatable only by the eraser identity) and the main
 * DB (legacy rows awaiting backfill). resolveSecurityAuditErasureTargets
 * pairs each store with the connection allowed to write it and the one to
 * verify it — so the chain checks target the stores the rows actually live
 * in, and a missing eraser configuration refuses the run instead of
 * misreporting a partial erasure as complete.
 */

const bodySchema = z.object({
  userId: z.string().min(1),
  legalBasis: z.string().trim().min(1),
  // Must equal `PSEUDONYMIZE <userId>` — explicit, subject-specific consent.
  confirmation: z.string().min(1),
});

export const POST = withAdminAuth(async (admin, request) => {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return Response.json(
      { error: 'Invalid request body (userId, legalBasis, confirmation required)' },
      { status: 400 }
    );
  }

  const { userId, legalBasis, confirmation } = parsed;
  if (confirmation.trim() !== `PSEUDONYMIZE ${userId}`) {
    return Response.json(
      { error: `Confirmation must be exactly "PSEUDONYMIZE ${userId}"` },
      { status: 400 }
    );
  }

  // 0. Resolve which stores hold the subject's audit rows and which identity
  //    may erase there. Refusal (no trust plane / no eraser) is loud — an
  //    erasure that cannot reach every store must not run at all.
  const resolved = resolveSecurityAuditErasureTargets();
  if (!resolved.ok) {
    loggers.auth.error(
      `Refusing pseudonymization for user ${userId}: ${resolved.reason}`,
      new Error('audit erasure targets unavailable')
    );
    return Response.json({ error: resolved.reason }, { status: 503 });
  }
  const { targets } = resolved;

  // 1. Verify the chains are intact BEFORE we touch anything — each security
  //    store verified via its own read connection.
  const [activityBefore, ...securityBefore] = await Promise.all([
    verifyHashChain(),
    ...targets.map((t) => verifySecurityAuditChain({}, { db: t.read })),
  ]);
  const securityBeforeByStore = Object.fromEntries(
    targets.map((t, i) => [t.store, securityBefore[i]!.isValid])
  );
  if (!activityBefore.isValid || securityBefore.some((r) => !r.isValid)) {
    return Response.json(
      {
        error: 'Refusing to pseudonymize: hash chain is already broken before the operation',
        activityChainValid: activityBefore.isValid,
        securityChainValid: securityBefore.every((r) => r.isValid),
        securityChainByStore: securityBeforeByStore,
      },
      { status: 409 }
    );
  }

  // 2. Apply the denormalized-actor-only patches — every store the subject's
  //    rows live in, each through the identity allowed to write it.
  const activityRows = await pseudonymizeActivityLogsForUser(userId);
  const securityRowsByStore: Record<string, number> = {};
  for (const target of targets) {
    securityRowsByStore[target.store] = await pseudonymizeSecurityAuditLogForUser(userId, {
      db: target.write,
    });
  }
  const securityRows = Object.values(securityRowsByStore).reduce((sum, n) => sum + n, 0);

  // 3. Verify the chains STILL hold. Pseudonymization touches no hash input, so
  //    this must pass — if it doesn't, surface loudly (do not swallow).
  const [activityAfter, ...securityAfter] = await Promise.all([
    verifyHashChain(),
    ...targets.map((t) => verifySecurityAuditChain({}, { db: t.read })),
  ]);
  const securityChainByStore = Object.fromEntries(
    targets.map((t, i) => [t.store, securityAfter[i]!.isValid])
  );
  const chainIntact = activityAfter.isValid && securityAfter.every((r) => r.isValid);

  // 4. Self-audit the operation (who, which subject, legal basis, counts).
  try {
    await securityAudit.logEvent({
      eventType: 'data.write',
      userId: admin.id,
      resourceType: 'audit_logs',
      resourceId: userId,
      details: {
        action: 'art17_pseudonymization',
        legalBasis,
        auditStoreMode: resolved.mode,
        activityRowsPseudonymized: activityRows,
        securityRowsPseudonymized: securityRows,
        securityRowsByStore,
        chainIntactAfter: chainIntact,
      },
    });
  } catch (error) {
    loggers.auth.error('Could not self-audit pseudonymization run:', error as Error);
  }

  if (!chainIntact) {
    loggers.auth.error(
      `Hash chain broke after pseudonymizing user ${userId} — INVESTIGATE`,
      new Error('chain integrity lost post-pseudonymization')
    );
    return Response.json(
      {
        error: 'Hash chain integrity lost after pseudonymization — investigate immediately',
        activityChainValid: activityAfter.isValid,
        securityChainValid: securityAfter.every((r) => r.isValid),
        securityChainByStore,
        activityBreakPoint: activityAfter.breakPoint,
        securityBreakPoints: Object.fromEntries(
          targets.map((t, i) => [t.store, securityAfter[i]!.breakPoint])
        ),
      },
      { status: 500 }
    );
  }

  loggers.auth.info(
    `Admin ${admin.id} pseudonymized user ${userId} (${resolved.mode}): ` +
      `${activityRows} activity rows, ${securityRows} security rows ` +
      `(${targets.map((t) => `${t.store}=${securityRowsByStore[t.store]}`).join(', ')}); chain intact`
  );

  return Response.json({
    message: 'Pseudonymization complete; hash chain verified intact',
    userId,
    auditStoreMode: resolved.mode,
    activityRowsPseudonymized: activityRows,
    securityRowsPseudonymized: securityRows,
    securityRowsByStore,
    chainIntact,
  });
});
