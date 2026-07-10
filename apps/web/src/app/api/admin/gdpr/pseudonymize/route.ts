import { z } from 'zod';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  pseudonymizeActivityLogsForUser,
  pseudonymizeSecurityAuditLogForUser,
} from '@pagespace/lib/compliance/erasure/pseudonymize-repository';
import { verifyHashChain } from '@pagespace/lib/monitoring/hash-chain-verifier';
import { verifySecurityAuditChain } from '@pagespace/lib/audit/security-audit-chain-verifier';
import { securityAudit } from '@pagespace/lib/audit/security-audit';
import { withAdminAuth } from '@/lib/auth/auth';

/**
 * Art 17(3)(b) audit-log pseudonymization (#985).
 *
 * The escalation path for a supervisory authority that disputes the retention
 * of `activity_logs` / `security_audit_log` under the legal-obligation
 * exemption. It overwrites ONLY the denormalized actor PII (never hash-chain or
 * content fields), verifies the tamper-evident chain before AND after (failing
 * loudly if the chain breaks), and self-audits the operation. Row deletion is
 * intentionally NOT offered — it would break the chain.
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

  // 1. Verify the chains are intact BEFORE we touch anything.
  const [activityBefore, securityBefore] = await Promise.all([
    verifyHashChain(),
    verifySecurityAuditChain(),
  ]);
  if (!activityBefore.isValid || !securityBefore.isValid) {
    return Response.json(
      {
        error: 'Refusing to pseudonymize: hash chain is already broken before the operation',
        activityChainValid: activityBefore.isValid,
        securityChainValid: securityBefore.isValid,
      },
      { status: 409 }
    );
  }

  // 2. Apply the denormalized-actor-only patches.
  const activityRows = await pseudonymizeActivityLogsForUser(userId);
  const securityRows = await pseudonymizeSecurityAuditLogForUser(userId);

  // 3. Verify the chains STILL hold. Pseudonymization touches no hash input, so
  //    this must pass — if it doesn't, surface loudly (do not swallow).
  const [activityAfter, securityAfter] = await Promise.all([
    verifyHashChain(),
    verifySecurityAuditChain(),
  ]);
  const chainIntact = activityAfter.isValid && securityAfter.isValid;

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
        activityRowsPseudonymized: activityRows,
        securityRowsPseudonymized: securityRows,
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
        securityChainValid: securityAfter.isValid,
        activityBreakPoint: activityAfter.breakPoint,
        securityBreakPoint: securityAfter.breakPoint,
      },
      { status: 500 }
    );
  }

  loggers.auth.info(
    `Admin ${admin.id} pseudonymized user ${userId}: ` +
      `${activityRows} activity rows, ${securityRows} security rows; chain intact`
  );

  return Response.json({
    message: 'Pseudonymization complete; hash chain verified intact',
    userId,
    activityRowsPseudonymized: activityRows,
    securityRowsPseudonymized: securityRows,
    chainIntact,
  });
});
