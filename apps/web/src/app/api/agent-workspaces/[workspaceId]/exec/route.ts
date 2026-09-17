/**
 * Run a shell command in a workspace's sandbox — the CLI/SDK shell surface.
 *
 * POST { command, cwd?, timeoutMs? } → 200 { stdout, stderr, exitCode, truncated }
 *
 * The chat `bash` tool, reachable by token: same input schema, same call-time
 * gate (kill switch, `canRunCode`, quota), same runner (command/path policy,
 * billing, audit). A cold workspace is provisioned on first exec, like opening
 * a shell. A non-zero `exitCode` is a 200 — the command ran; only a refusal is
 * an error status, answered as `{ error, reason, retryAfter? }`.
 *
 * Unreachable, denied, out of the credential's drive scope, below the drive
 * edit bar for the credential's own role (a scoped key), and ended all
 * answer the SAME 404 — this family never tells a caller a workspace exists.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, isDriveScopedPrincipal } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { SandboxToolDenialReason } from '@pagespace/lib/services/sandbox/tool-runners';
import { bashInputSchema } from '@/lib/ai/tools/sandbox-tools';
import { checkSessionAccess, findSessionRecord } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { auditSessionAccessDenial } from '@/lib/agent-workspaces/workspace-unavailable-response';
import { isWorkspaceInCredentialScope } from '@/lib/agent-workspaces/credential-scope';
import { canPrincipalRunCodeInDrive } from '@/lib/agent-workspaces/principal-code-exec-access';
import { execInWorkspace, resolveWorkspaceExecActorContext } from '@/lib/agent-workspaces/workspace-exec-runtime';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]/exec';

type RouteContext = { params: Promise<{ workspaceId: string }> };

/** Every refusal the gate or runner can answer, mapped to a status. Exhaustive by type. */
const DENIAL_STATUS: Record<SandboxToolDenialReason, number> = {
  kill_switch_off: 403,
  tier_ineligible: 403,
  no_drive_access: 403,
  insufficient_role: 403,
  no_agent_access: 403,
  local_bind_denied: 403,
  credit_exhausted: 402,
  concurrency_limit: 429,
  session_runtime_exceeded: 429,
  session_limit_reached: 429,
  empty_command: 400,
  command_too_large: 400,
  blocked_metadata_access: 400,
  github_over_bash: 400,
  path_escape: 400,
  content_too_large: 400,
  binary_content: 400,
  edit_no_match: 400,
  edit_not_unique: 400,
  not_found: 404,
  no_session: 404,
  no_machine: 503,
  provision_failed: 503,
  local_not_connected: 503,
  checkpoint_unsupported: 503,
  execution_failed: 500,
  error: 500,
};

function statusForReason(reason: string): number {
  return (DENIAL_STATUS as Record<string, number | undefined>)[reason] ?? 500;
}

const notFound = () => NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bashInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((issue) => issue.message).join('; '), reason: 'invalid_input' },
      { status: 400 },
    );
  }

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    auditSessionAccessDenial(request, auth.userId, workspaceId, access.reason, ROUTE);
    return notFound();
  }
  const session = await findSessionRecord(workspaceId);
  if (!session || session.endedAt !== null) return notFound();
  if (!isWorkspaceInCredentialScope(auth, session.driveId)) {
    auditSessionAccessDenial(request, auth.userId, workspaceId, 'credential_out_of_scope', ROUTE);
    return notFound();
  }
  // The gates below authorize the OWNING USER. A drive-scoped key can carry a
  // weaker explicit role than its owner, so the credential itself must clear
  // the same drive edit bar first. (A driveless workspace is already out of
  // every drive scope, above.)
  if (
    session.driveId !== null &&
    isDriveScopedPrincipal(auth) &&
    !(await canPrincipalRunCodeInDrive(auth, session.driveId))
  ) {
    auditSessionAccessDenial(request, auth.userId, workspaceId, 'credential_insufficient_role', ROUTE);
    return notFound();
  }

  try {
    const ctx = await resolveWorkspaceExecActorContext(session, auth.userId);
    if ('error' in ctx) return NextResponse.json({ error: ctx.error, reason: 'no_drive_access' }, { status: 403 });

    const result = await execInWorkspace({ session, ctx, ...parsed.data });
    if (!result.success) {
      const { error, reason } = result;
      const retryAfter = 'retryAfter' in result ? result.retryAfter : undefined;
      return NextResponse.json(
        { error, reason, ...(retryAfter ? { retryAfter } : {}) },
        { status: statusForReason(reason) },
      );
    }
    const { stdout, stderr, exitCode, truncated } = result;
    return NextResponse.json({ stdout, stderr, exitCode, truncated });
  } catch (error) {
    loggers.api.error('Workspace exec failed', error instanceof Error ? error : new Error(String(error)), {
      workspaceId,
    });
    return NextResponse.json({ error: 'Command execution failed', reason: 'error' }, { status: 500 });
  }
}
