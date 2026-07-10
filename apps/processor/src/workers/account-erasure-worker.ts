/**
 * Durable GDPR account-erasure worker (#906, #908, #913, #912).
 *
 * pg-boss invokes this for each `account-erasure` job. It wires the concrete
 * side-effecting steps and hands them to the pure `runErasure` orchestrator,
 * which records per-step evidence on the data_subject_requests row and decides
 * completed / blocked / failed. A thrown error propagates to pg-boss so the job
 * is retried with backoff; a "blocked" outcome is terminal-for-retry and waits
 * for human escalation (admin force-delete).
 */

import { accountRepository } from '@pagespace/lib/repositories/account-repository';
import { activityLogRepository } from '@pagespace/lib/repositories/activity-log-repository';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import { planDriveDisposition } from '@pagespace/lib/compliance/erasure/drive-disposition';
import {
  buildErasurePlan,
  ERASURE_BLOCKED_PREFIX,
  type DeploymentMode,
  type ErasureStepId,
} from '@pagespace/lib/compliance/erasure/erasure-plan';
import { runErasure, type RunnableStep } from '@pagespace/lib/compliance/erasure/run-erasure';
import { createAnonymizedActorEmail } from '@pagespace/lib/compliance/anonymize';
import {
  deleteAiUsageLogsForUser,
  getDistinctAiProvidersForUser,
} from '@pagespace/lib/logging/ai-usage-purge';
import { deleteMonitoringDataForUser } from '@pagespace/lib/logging/monitoring-purge';
import { revokeUserIntegrationTokens } from '@pagespace/lib/compliance/erasure/revoke-integration-tokens';
import { syncEmailSuppression } from '@pagespace/lib/compliance/erasure/email-suppression';
import { createResendSuppressionClient } from '@pagespace/lib/compliance/erasure/resend-suppression-client';
import { eraseAiProviderData } from '@pagespace/lib/compliance/erasure/ai-provider-erasure';
import { securityAudit } from '@pagespace/lib/audit/security-audit';
import { logActivity, getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { isClickHouseAnalyticsInPlay } from '@pagespace/lib/observability/clickhouse-client';
import { isOnPrem, isTenantMode } from '@pagespace/lib/deployment-mode';
import type { AccountErasureJobData } from '../types';
import { deleteUserAvatars } from '../api/avatar';

function resolveDeploymentMode(): DeploymentMode {
  if (isOnPrem()) return 'onprem';
  if (isTenantMode()) return 'tenant';
  return 'cloud';
}

const ok = (detail?: string) => ({ status: 'ok' as const, detail });
const skipped = (detail?: string) => ({ status: 'skipped' as const, detail });

export async function runAccountErasureJob(data: AccountErasureJobData): Promise<void> {
  const { requestId, userId } = data;

  const request = await dataSubjectRequestRepository.findById(requestId);
  if (!request) {
    console.warn(`[account-erasure] DSR ${requestId} not found; dropping job`);
    return;
  }
  if (request.status === 'completed' || request.status === 'cancelled') {
    console.log(`[account-erasure] DSR ${requestId} already ${request.status}; nothing to do`);
    return;
  }

  await dataSubjectRequestRepository.incrementAttempts(requestId);

  const user = await accountRepository.findById(userId);
  if (!user) {
    // Idempotent: the user row is already gone (a prior attempt deleted it).
    await dataSubjectRequestRepository.appendStepResult(requestId, {
      step: 'delete-user',
      status: 'skipped',
      detail: 'user already absent',
      at: new Date().toISOString(),
    });
    await dataSubjectRequestRepository.updateStatus(requestId, 'completed', {
      completedAt: new Date(),
    });
    return;
  }

  const mode = resolveDeploymentMode();
  const forceDelete = request.forceDelete;

  // Concrete step implementations keyed by the plan's step ids.
  const impls: Partial<Record<ErasureStepId, () => Promise<{ status: 'ok' | 'skipped'; detail?: string }>>> = {
    'drive-disposition': async () => {
      const owned = await accountRepository.getOwnedDrives(userId);
      const withCounts = await Promise.all(
        owned.map(async (d) => ({
          id: d.id,
          name: d.name,
          memberCount: await accountRepository.getDriveMemberCount(d.id),
        }))
      );
      const plan = planDriveDisposition(withCounts, { forceDelete });
      if (plan.blocked) {
        throw new Error(`${ERASURE_BLOCKED_PREFIX}: ${plan.multiMemberDriveNames.join(', ')}`);
      }
      for (const driveId of plan.drivesToDelete) {
        await accountRepository.deleteDrive(driveId);
      }
      return ok(
        `deleted ${plan.drivesToDelete.length} drive(s)` +
          (plan.forcedDriveIds.length ? `, force-deleted ${plan.forcedDriveIds.length}` : '')
      );
    },

    'delete-avatar': async () => {
      if (!user.image) return skipped('no avatar');
      await deleteUserAvatars(userId);
      return ok('avatar objects removed');
    },

    'log-account-deletion': async () => {
      const actorInfo = await getActorInfo(userId);
      await logActivity({
        userId,
        actorEmail: actorInfo?.actorEmail ?? 'unknown@system',
        actorDisplayName: actorInfo?.actorDisplayName,
        operation: 'account_delete',
        resourceType: 'user',
        resourceId: userId,
        resourceTitle: user.email ?? undefined,
        driveId: null,
      });
      return ok();
    },

    'anonymize-activity-logs': async () => {
      const result = await activityLogRepository.anonymizeForUser(
        userId,
        createAnonymizedActorEmail(userId)
      );
      if (!result.success) throw new Error(result.error ?? 'anonymize failed');
      return ok();
    },

    'purge-ai-usage': async () => {
      const deleted = await deleteAiUsageLogsForUser(userId);
      return ok(`${deleted} rows`);
    },

    'purge-monitoring': async () => {
      const counts = await deleteMonitoringDataForUser(userId);
      return ok(JSON.stringify(counts));
    },

    'revoke-integrations': async () => {
      const { revoked, failed } = await revokeUserIntegrationTokens(userId);
      return ok(`revoked=${revoked} failed=${failed}`);
    },

    'email-suppression': async () => {
      const result = await syncEmailSuppression(
        { email: user.email, userId, deploymentMode: mode },
        createResendSuppressionClient()
      );
      if (result.skipped) return skipped('no external email provider');
      return ok(`suppressed=${result.suppressed} failed=${result.failed}`);
    },

    'ai-provider-erasure': async () => {
      const providers = await getDistinctAiProvidersForUser(userId);
      const result = await eraseAiProviderData(
        { userId, providers, deploymentMode: mode },
        { forwardDeletion: async () => {} }
      );
      return ok(
        `providers=${result.evidence.length} forwarded=${result.forwarded} ` +
          `manualReview=${result.evidence.filter((e) => e.action === 'manual_review').length}`
      );
    },

    'security-audit': async () => {
      await securityAudit.logEvent({
        eventType: 'admin.user.deleted',
        userId,
        resourceType: 'account',
        resourceId: userId,
      });
      return ok();
    },

    'delete-user': async () => {
      await accountRepository.deleteUser(userId);
      return ok();
    },
  };

  // Stripe lives in the web app (its SDK isn't bundled here); the web records
  // that step on the DSR row at enqueue time, so the durable job skips it.
  const steps: RunnableStep[] = buildErasurePlan({
    deploymentMode: mode,
    // With CH configured at all (flag-independent), purge-monitoring becomes
    // fatal: a CH purge failure must fail the run for retry, not complete it
    // with the subject's error rows retained forever (error_logs has no TTL).
    clickHouseInPlay: isClickHouseAnalyticsInPlay(),
  })
    .filter((step) => step.id !== 'stripe-customer')
    .map((step) => ({
      id: step.id,
      fatal: step.fatal,
      run: impls[step.id] ?? (async () => skipped('no-op')),
    }));

  const result = await runErasure({
    requestId,
    steps,
    attemptsSoFar: request.attempts,
    recorder: dataSubjectRequestRepository,
    now: () => new Date(),
  });

  if (result.status === 'failed') {
    // Surface to pg-boss for retry with backoff.
    throw new Error(`account-erasure failed at step ${result.failedStep}: ${result.error}`);
  }
  console.log(`[account-erasure] DSR ${requestId} -> ${result.status}`);
}
