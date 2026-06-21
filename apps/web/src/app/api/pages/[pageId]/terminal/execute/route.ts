import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError, canPrincipalEditPage } from '@/lib/auth';
import { canRunCode, isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { getSandboxSessionSecret } from '@pagespace/lib/services/sandbox/session-manager';
import {
  acquireTerminalSandbox,
  createDbTerminalSessionStore,
} from '@pagespace/lib/services/sandbox/terminal-session-manager';
import {
  checkCodeExecutionQuota,
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  chargeCodeExecutionBudget,
} from '@pagespace/lib/services/sandbox/quota';
import { truncateToBytes } from '@pagespace/lib/services/sandbox/output-limit';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const bodySchema = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().optional(),
});

const VALID_TIERS: ReadonlySet<string> = new Set(['free', 'pro', 'founder', 'business']);

function toTier(value: string | null | undefined): SubscriptionTier {
  return value && VALID_TIERS.has(value) ? (value as SubscriptionTier) : 'free';
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const { pageId } = await params;

  // 1. Kill-switch — fail fast before auth so a misconfigured host never
  //    exposes the auth surface for a disabled feature.
  if (!isCodeExecutionEnabled()) {
    return NextResponse.json({ error: 'Code execution is not enabled' }, { status: 503 });
  }

  // 2. Auth — session only; no MCP tokens for direct terminal execution.
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;
  if (auth.role !== 'admin') {
    auditRequest(req, { eventType: 'authz.access.denied', userId, resourceType: 'terminal_session', resourceId: pageId, details: { reason: 'app_admin_required', method: 'POST' }, riskScore: 0.5 });
    return NextResponse.json({ error: 'Terminal access requires administrator privileges' }, { status: 403 });
  }

  // 3. Page permission: editor+ required to run code.
  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    auditRequest(req, { eventType: 'authz.access.denied', userId, resourceType: 'terminal_session', resourceId: pageId, details: { reason: 'no_edit_permission', method: 'POST' }, riskScore: 0.5 });
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }

  // 4. Parse and validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { command, cwd } = parsed.data;

  // 5. Resolve page → driveId, then drive → tenantId (ownerId) and user → tier.
  const [pageRow] = await db
    .select({ driveId: pages.driveId })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  if (!pageRow) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }
  const { driveId } = pageRow;

  const codeAuth = await canRunCode({ userId, driveId, requestOrigin: 'user' });
  if (!codeAuth.ok) {
    auditRequest(req, { eventType: 'authz.access.denied', userId, resourceType: 'terminal_session', resourceId: pageId, details: { reason: codeAuth.reason, method: 'POST' }, riskScore: 0.5 });
    return NextResponse.json({ error: 'Code execution is not available for this user' }, { status: 403 });
  }

  const [driveRow, actorRow] = await Promise.all([
    db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId)).limit(1),
    db.select({ subscriptionTier: users.subscriptionTier, email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  const tenantId = driveRow[0]?.ownerId ?? '';
  const tier = toTier(actorRow[0]?.subscriptionTier);

  // 6. Advisory quota preflight (does not increment counters).
  const quota = await checkCodeExecutionQuota({ userId, driveId, tenantId, tier });
  if (!quota.allowed) {
    return NextResponse.json({ error: 'Quota exceeded' }, { status: 429 });
  }

  // 7. Acquire per-user concurrency slot.
  const acquired = acquireCodeExecutionSlot({ userId, tier });
  if (!acquired) {
    return NextResponse.json({ error: 'Too many concurrent executions' }, { status: 429 });
  }

  const startMs = Date.now();
  try {
    // 8. Acquire (or resume) the page's terminal sandbox.
    // @fly/sprites is ESM-only — import dynamically so webpack does not attempt
    // to bundle it at build time (same pattern as sandbox-tools-runtime.ts).
    const [store, { createSpritesSandboxClient }] = await Promise.all([
      createDbTerminalSessionStore(),
      import('@pagespace/lib/services/sandbox/sandbox-client/sprites'),
    ]);
    const client = createSpritesSandboxClient();

    const sandboxResult = await acquireTerminalSandbox({
      pageId,
      driveId,
      tenantId,
      userId,
      canRun: true,
      deps: {
        store,
        client,
        now: () => new Date(),
        secret: getSandboxSessionSecret(),
      },
    });

    if (!sandboxResult.ok) {
      const status = sandboxResult.reason === 'deny' ? 403 : 500;
      return NextResponse.json({ error: 'Could not acquire sandbox' }, { status });
    }

    // 9. Reconnect to the executable Sprite to get the runCommand surface.
    const sprite = await client.get({ sandboxId: sandboxResult.sandboxId });
    if (!sprite) {
      return NextResponse.json({ error: 'Sandbox not available' }, { status: 500 });
    }

    // 10. Run the command via sh -c (structured spawn, no host-side shell string).
    const result = await sprite.runCommand({
      cmd: 'sh',
      args: ['-c', command],
      cwd,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxBytes: MAX_OUTPUT_BYTES,
    });

    const rawOutput = result.stdout + (result.stderr ? '\n' + result.stderr : '');
    const { text: output } = truncateToBytes({ text: rawOutput, maxBytes: MAX_OUTPUT_BYTES });
    const durationMs = Date.now() - startMs;

    // Charge the sliding-window budget, emit the security audit event, and write
    // the code execution audit record. All three are fire-and-forget: a failure
    // in any must not discard output the command already produced.
    chargeCodeExecutionBudget({ userId, driveId, tenantId }).catch(() => {});
    auditRequest(req, { eventType: 'data.write', userId, resourceType: 'terminal_session', resourceId: pageId, details: { exitCode: result.exitCode, durationMs }, riskScore: 0 });
    writeCodeExecutionAudit({
      input: {
        userId,
        actorEmail: actorRow[0]?.email ?? '',
        actorDisplayName: actorRow[0]?.name ?? undefined,
        driveId,
        requestOrigin: 'user',
        profile: 'default',
        code: command,
        exitCode: result.exitCode,
        durationMs,
        timestamp: new Date(),
      },
    }).catch(() => {});

    return NextResponse.json({ output, exitCode: result.exitCode, durationMs });
  } catch {
    return NextResponse.json({ error: 'Execution failed' }, { status: 500 });
  } finally {
    // 11. Always release the concurrency slot — even on errors — so a failed
    //     execution can never strand a user's slot until process restart.
    releaseCodeExecutionSlot({ userId });
  }
}
