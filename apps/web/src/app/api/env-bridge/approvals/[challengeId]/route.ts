/**
 * The owner's click on a pending local-environment approval — `/api/env-bridge/approvals/[challengeId]`
 * (GA wave 2, leaves 5–6; Tier B).
 *
 * GET   → { challengeId, envId, principal, expiresAt, request }   — the ENV OWNER only
 * POST  { decision: 'allow' | 'deny', scope? } → { outcome, … }   — the ENV OWNER only
 *
 * A machine that reached the `ask` verdict froze the exact normalised request
 * under a challenge id and answered `ask_pending:<id>`; the bridge client
 * remembered what re-issuing it needs (`pending-approvals.ts`). This route
 * lets the environment's OWNER — and nobody else — see that frozen request
 * (the card renders it verbatim, as the machine signed it) and answer it.
 *
 * **Owner only, by the row ([D-6]).** The clicker must be
 * `drive_env_local.ownerId`. A drive admin who did not enrol the machine is
 * 403 (`not_owner`), audited. No drive role is consulted: approving a command
 * on someone else's laptop is not drive administration.
 *
 * **Allow re-issues, it does not run.** On Allow the server sends the machine
 * the SAME unsigned frame it sent before, under the same principal, as a fresh
 * grant carrying a server-signed `approvalIntent { challengeId, scope,
 * expiresAt }`. The MACHINE looks the frozen request up by that id,
 * byte-compares the re-issued request against it, and runs only on a match
 * (`approval_mismatch` otherwise — including for a challenge the machine
 * never froze). This route can only ask the machine to
 * honour a question the machine itself framed; it cannot introduce a request.
 *
 * **After the challenge TTL ⇒ `approval_expired`** (410): the frozen request
 * dies with the grant that framed it, on the machine and here.
 *
 * Every answer is audited on the env with the challenge id.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import type { MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import { ENV_APPROVAL_SCOPES, ENV_APPROVAL_STDERR_MAX_CHARS, ENV_APPROVAL_STDOUT_MAX_CHARS, type RequestEnvApprovalOutput } from '@/lib/ai/tools/env-approval-tools';
import { EnvBridgeError, getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { getPendingApprovalStore, type PendingEnvApproval } from '@/lib/env-bridge/pending-approvals';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const bodySchema = z
  .object({
    decision: z.enum(['allow', 'deny']),
    scope: z.enum(ENV_APPROVAL_SCOPES).optional(),
  })
  .strict();

type Params = { params: Promise<{ challengeId: string }> };

/** The pending entry and the sibling it belongs to, or the response that ends the request. */
async function loadForOwner(request: Request, challengeId: string, userId: string, now: number): Promise<{ ok: true; pending: PendingEnvApproval; ownerId: string } | { ok: false; response: Response }> {
  const pending = getPendingApprovalStore().get(challengeId, now);
  if (!pending) {
    auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'drive_env_approval', resourceId: challengeId, details: { route: 'env-bridge/approvals', reason: 'unknown_or_expired' } });
    return { ok: false, response: NextResponse.json({ error: 'No pending approval with this id — it was answered, or the request it froze has expired', outcome: 'expired', reason: 'approval_expired' }, { status: 410 }) };
  }
  const sibling = await (await getDriveEnvStore()).findLocalByEnvId(pending.envId);
  if (!sibling || sibling.revokedAt !== null) {
    getPendingApprovalStore().take(challengeId, now);
    return { ok: false, response: NextResponse.json({ error: 'Environment not found', outcome: 'unknown' }, { status: 404 }) };
  }
  // The env OWNER only (D-6): the human who enrolled the machine, never a drive role.
  if (sibling.ownerId !== userId) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId,
      resourceType: 'drive_env',
      resourceId: pending.envId,
      details: { route: 'env-bridge/approvals', operation: 'approve', challengeId, ownerId: sibling.ownerId },
      riskScore: 0.5,
    });
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Only this machine's owner (the user who enrolled it, ${sibling.ownerId}) can approve what runs on it — drive admins can delete or revoke it, but not drive it`, outcome: 'not_owner', reason: 'not_owner', ownerId: sibling.ownerId },
        { status: 403 },
      ),
    };
  }
  return { ok: true, pending, ownerId: sibling.ownerId };
}

export async function GET(request: Request, context: Params) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const { challengeId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const loaded = await loadForOwner(request, challengeId, auth.userId, Date.now());
    if (!loaded.ok) return loaded.response;
    const { pending } = loaded;
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive_env', resourceId: pending.envId, details: { route: 'env-bridge/approvals', operation: 'read', challengeId } });
    return NextResponse.json({
      challengeId,
      envId: pending.envId,
      principal: pending.principal,
      expiresAt: pending.expiresAt,
      // Verbatim: the frozen request as the MACHINE signed it.
      request: pending.pending.request,
      scopes: ENV_APPROVAL_SCOPES,
    });
  } catch (error) {
    loggers.api.error('Failed to read a pending environment approval', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to read the pending approval' }, { status: 500 });
  }
}

/** Cut a stream to the tool output bound (UTF-16 length, the unit zod measures); says whether it cut. */
function bounded(text: string, maxChars: number): { text: string; cut: boolean } {
  return text.length > maxChars ? { text: text.slice(0, maxChars), cut: true } : { text, cut: false };
}

/** The tool result for a machine reply to the re-issued grant. Output is truncated to the schema's bounds so the result always merges. */
function outcomeOf(challengeId: string, scope: RequestEnvApprovalOutput['scope'], reply: MachineResultFrame): RequestEnvApprovalOutput {
  switch (reply.type) {
    case 'exec_result': {
      const stdout = bounded(Buffer.from(reply.stdoutB64, 'base64').toString('utf8'), ENV_APPROVAL_STDOUT_MAX_CHARS);
      const stderr = bounded(Buffer.from(reply.stderrB64, 'base64').toString('utf8'), ENV_APPROVAL_STDERR_MAX_CHARS);
      return {
        challengeId,
        outcome: 'allowed',
        scope,
        exitCode: reply.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: reply.truncated || stdout.cut || stderr.cut,
      };
    }
    case 'fs_write_result':
      return reply.ok ? { challengeId, outcome: 'allowed', scope } : { challengeId, outcome: 'failed', scope, error: reply.error ?? 'write failed' };
    case 'fs_read_result':
      return { challengeId, outcome: 'allowed', scope };
    case 'approval_revoke_result':
      // Not an answer to a grant; a click can never be answered by a revoke ack.
      return { challengeId, outcome: 'failed', error: 'unexpected_frame' };
    case 'grant_denied':
      if (reply.reason === 'approval_mismatch') return { challengeId, outcome: 'mismatch', error: reply.reason };
      if (reply.reason === 'approval_expired') return { challengeId, outcome: 'expired', error: reply.reason };
      return { challengeId, outcome: 'failed', error: reply.reason };
  }
}

export async function POST(request: Request, context: Params) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const { challengeId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'decision (allow | deny) is required; scope is one of once | session | 30d | until_revoked' }, { status: 400 });

    const now = Date.now();
    const loaded = await loadForOwner(request, challengeId, auth.userId, now);
    if (!loaded.ok) return loaded.response;
    const { pending } = loaded;
    const store = getPendingApprovalStore();

    if (parsed.data.decision === 'deny') {
      store.take(challengeId, now);
      auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'drive_env', resourceId: pending.envId, details: { route: 'env-bridge/approvals', operation: 'deny', challengeId } });
      const output: RequestEnvApprovalOutput = { challengeId, outcome: 'denied' };
      return NextResponse.json(output);
    }

    const scope = parsed.data.scope ?? '30d';
    // Spent before the re-issue: one click answers one question, whatever the machine says next.
    store.take(challengeId, now);
    let reply: MachineResultFrame;
    try {
      reply = await getEnvBridgeClient().sendGrant({
        envId: pending.envId,
        frame: pending.frame,
        principal: pending.principal,
        approvalIntent: { challengeId, scope, expiresAt: pending.expiresAt },
      });
    } catch (error) {
      const kind = error instanceof EnvBridgeError ? error.kind : 'error';
      auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'drive_env', resourceId: pending.envId, details: { route: 'env-bridge/approvals', operation: 'allow', challengeId, scope, outcome: 'failed', error: kind } });
      const output: RequestEnvApprovalOutput = { challengeId, outcome: 'failed', scope, error: kind };
      return NextResponse.json(output, { status: 502 });
    }
    const output = outcomeOf(challengeId, scope, reply);
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive_env',
      resourceId: pending.envId,
      details: { route: 'env-bridge/approvals', operation: 'allow', challengeId, scope, outcome: output.outcome, ...(output.exitCode !== undefined && { exitCode: output.exitCode }) },
    });
    return NextResponse.json(output, { status: output.outcome === 'allowed' ? 200 : output.outcome === 'expired' ? 410 : 409 });
  } catch (error) {
    loggers.api.error('Failed to answer a pending environment approval', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to answer the pending approval' }, { status: 500 });
  }
}
