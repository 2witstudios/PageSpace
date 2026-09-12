/**
 * The owner's click on a pending local-environment approval — `/api/env-bridge/approvals/[challengeId]`
 * (GA wave 2, leaves 5–6; Tier B).
 *
 * GET   → { challengeId, envId, principal, expiresAt, request }   — the ENV OWNER only
 * POST  { decision: 'allow' | 'deny', scope? } → { outcome, … }   — the ENV OWNER only
 * DELETE → revoke the durable approval this id names            — the ENV OWNER only, NO drive check (Codex P1 #5, review round 1)
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
import { getApprovalMirrorStore, getDriveEnvStore, markEnvApprovalAcknowledged, markEnvApprovalRevoked, rememberEnvApproval } from '@/lib/drive-envs/drive-envs-runtime';
import { revokeLocalEnvApproval } from '@/lib/env-bridge/revoke';
import { approvalExpiry } from '@pagespace/lib/env-bridge/decide-approval';
import { approvalAssertionSchema } from '@pagespace/lib/env-bridge/grant';
import { deriveOwnerApprovalChallenge } from '@pagespace/lib/env-bridge/owner-approval';
import { envBridgeSha256 } from '@/lib/env-bridge/crypto';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const bodySchema = z
  .object({
    decision: z.enum(['allow', 'deny']),
    scope: z.enum(ENV_APPROVAL_SCOPES).optional(),
    /**
     * The owner's WebAuthn assertion (hardening B, leaf B3). Deliberately
     * added to a `.strict()` schema — an unknown field is a 400 here, so this
     * had to be opened on purpose.
     *
     * The server RELAYS it and does not verify it. That is not an oversight
     * and it is not the step-up flow's shape: the party that must be
     * convinced a human clicked is the MACHINE, and a check performed here
     * would be exactly the server-attestation this whole change exists to
     * remove. Optional at this layer so the machine — not this route — is
     * what refuses a click without one, with its own typed reason.
     */
    assertion: approvalAssertionSchema.optional(),
  })
  .strict();

type Params = { params: Promise<{ challengeId: string }> };

/** The pending entry and the sibling it belongs to, or the response that ends the request. */
async function loadForOwner(request: Request, challengeId: string, userId: string, now: number): Promise<{ ok: true; pending: PendingEnvApproval; ownerId: string; sibling: NonNullable<LocalSibling> } | { ok: false; response: Response }> {
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
  return { ok: true, pending, ownerId: sibling.ownerId, sibling };
}

/** The row's pinned owner credentials, as `drive_env_local` stores them. */
type LocalSibling = Awaited<ReturnType<Awaited<ReturnType<typeof getDriveEnvStore>>['findLocalByEnvId']>>;

/**
 * The WebAuthn options the card runs `startAuthentication` with. `available:
 * false` means the machine pinned nothing (or an empty set): the card must
 * say the approval has to be answered in the terminal instead, because the
 * daemon will refuse a chat click on this machine (leaf B5).
 */
function webauthnOptionsFor(sibling: LocalSibling, challengeId: string, envId: string, request: PendingEnvApproval['pending']['request']) {
  const pinned = sibling?.ownerCredentials ?? null;
  const credentials = pinned?.credentials ?? [];
  return {
    available: credentials.length > 0,
    rpId: pinned?.rpId ?? null,
    /**
     * ONE CHALLENGE PER SCOPE. The challenge binds the scope (Codex P1 on
     * #2599) and the owner picks the scope on the card, after this response —
     * so the card signs the one matching its selection. Deriving all four here
     * keeps the browser free of hashing, and a card that signs the wrong one
     * simply fails on the machine rather than approving anything.
     */
    challenges: Object.fromEntries(ENV_APPROVAL_SCOPES.map((scope) => [scope, deriveOwnerApprovalChallenge({ envId, challengeId, request, scope }, envBridgeSha256)])) as Record<(typeof ENV_APPROVAL_SCOPES)[number], string>,
    allowCredentials: credentials.map((credential) => ({ id: credential.credentialId, type: 'public-key' as const })),
  };
}

export async function GET(request: Request, context: Params) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const { challengeId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const loaded = await loadForOwner(request, challengeId, auth.userId, Date.now());
    if (!loaded.ok) return loaded.response;
    const { pending, sibling } = loaded;
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive_env', resourceId: pending.envId, details: { route: 'env-bridge/approvals', operation: 'read', challengeId } });
    return NextResponse.json({
      challengeId,
      envId: pending.envId,
      principal: pending.principal,
      expiresAt: pending.expiresAt,
      // Verbatim: the frozen request as the MACHINE signed it.
      request: pending.pending.request,
      // For a write, the machine's own per-file findings — path, mode, byte
      // count and why it was escalated, in the classifier's closed vocabulary
      // (hardening A7). Passed through untouched: the card must never render a
      // word the server or the model composed.
      ...(pending.pending.files !== undefined && { files: pending.pending.files }),
      scopes: ENV_APPROVAL_SCOPES,
      // What the card needs to run the WebAuthn ceremony (hardening B). The
      // challenge is DERIVED from the frozen request, never random, and the
      // machine recomputes it from the request IT froze — so a wrong
      // challenge here cannot make anything run, it only fails the click.
      // `allowCredentials` is the set the MACHINE pinned at enrolment, not
      // every passkey the owner has: offering a key registered since would
      // have them touch one the daemon then refuses, with nothing to explain
      // it.
      webauthn: webauthnOptionsFor(sibling, challengeId, pending.envId, pending.pending.request),
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
    case 'pause_result':
      // Not an answer to a grant; a click can never be answered by an ack.
      return { challengeId, outcome: 'failed', error: 'unexpected_frame' };
    case 'grant_denied':
      if (reply.reason === 'approval_mismatch') return { challengeId, outcome: 'mismatch', error: reply.reason };
      if (reply.reason === 'approval_expired') return { challengeId, outcome: 'expired', error: reply.reason };
      if (reply.reason === 'approval_unproven') {
        // Say what to fix, because the question is still answerable.
        return { challengeId, outcome: 'failed', error: 'approval_unproven: the machine could not verify that you clicked. Approve in the terminal running "pagespace env connect", or — if this machine has no passkey pinned — register one and re-enrol it. The request is still pending until it expires.' };
      }
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
    /**
     * Spent before the re-issue, so two concurrent clicks cannot both run —
     * but RESTORED below when the machine's answer is not a decision (Codex on
     * #2599). A proof the machine could not use is a recoverable error, and
     * burning the question turns it into a dead end: the owner would be told
     * "unproven" with nothing left to retry against, and the daemon still
     * holds its own challenge (it only spends one on a verified allow), so the
     * two would disagree until the TTL.
     */
    store.take(challengeId, now);
    /** Put the question back exactly as it was, for anything that is not the owner's decision. */
    const restorePending = () => {
      if (pending.expiresAt > Date.now()) store.remember(pending, Date.now());
    };
    let reply: MachineResultFrame;
    try {
      reply = await getEnvBridgeClient().sendGrant({
        envId: pending.envId,
        frame: pending.frame,
        principal: pending.principal,
        // The assertion rides INSIDE the intent, so the grant signature covers
        // it — relayed intact, never verified-and-discarded here.
        approvalIntent: { challengeId, scope, expiresAt: pending.expiresAt, ...(parsed.data.assertion !== undefined && { assertion: parsed.data.assertion }) },
      });
    } catch (error) {
      // The machine never answered, so the owner never decided: the question stands.
      restorePending();
      const kind = error instanceof EnvBridgeError ? error.kind : 'error';
      auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'drive_env', resourceId: pending.envId, details: { route: 'env-bridge/approvals', operation: 'allow', challengeId, scope, outcome: 'failed', error: kind } });
      const output: RequestEnvApprovalOutput = { challengeId, outcome: 'failed', scope, error: kind };
      return NextResponse.json(output, { status: 502 });
    }
    const output = outcomeOf(challengeId, scope, reply);
    // `approval_unproven` means the machine could not USE the proof — no
    // passkey pinned, a cancelled or malformed assertion, a scope it was not
    // made for. The owner has not answered anything, and the daemon has not
    // spent its challenge either, so neither does this.
    if (reply.type === 'grant_denied' && reply.reason === 'approval_unproven') restorePending();
    // The MIRROR (GA wave 3, leaf 5): the machine remembered this approval
    // (it ran on a byte-compared match, under the challenge id, for every
    // scope but `once`), so the server records what the owner can now see and
    // revoke. Visibility only: nothing here can widen what runs.
    if (output.outcome === 'allowed' && scope !== 'once') {
      const frozen = pending.pending.request;
      // A session-scoped row is tied to the daemon process that holds it (its last hello's epoch, Codex P2 #7).
      const epoch = scope === 'session' ? ((await (await getDriveEnvStore()).findLocalByEnvId(pending.envId))?.daemonEpoch ?? null) : null;
      const argv = frozen.op === 'exec' ? [frozen.cmd ?? '', ...(frozen.args ?? [])].join(' ') : frozen.paths.join(', ');
      try {
        await rememberEnvApproval({ id: challengeId, envId: pending.envId, userId: auth.userId, op: frozen.op, summary: `${frozen.op}: ${argv}${frozen.op === 'exec' ? ` in ${frozen.cwd}` : ''}`, scope, daemonEpoch: epoch, createdAt: new Date(now), expiresAt: approvalExpiry(scope, now) === null ? null : new Date(approvalExpiry(scope, now)!) });
      } catch (error) {
        // The machine already ran it and remembered it; the click's answer does not depend on the mirror.
        loggers.api.error('Approval mirror write failed after an allowed click', error instanceof Error ? error : new Error(String(error)));
      }
    }
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

/**
 * Revoke ONE durable approval from ACCOUNT settings (Codex P1 #5, review round
 * 1). The id is the challenge id the click was answered under — what the
 * machine's file keys the approval on and what the drive route's DELETE names
 * too. OWNER-SCOPED, never drive-scoped: the reader checks
 * `drive_env_local.ownerId` and nothing else, so an owner who has since left
 * the drive can still revoke what their own machine will run, and a drive
 * admin who is not the owner cannot — the account page must never offer a
 * button that 403s for the person it is for. Rides the same signed revoke
 * frame, the same ack, and the same mirror stamps as the drive route; same
 * honest 200 / 202 / 409 shape.
 */
export async function DELETE(request: Request, context: Params) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const { challengeId: approvalId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const mirrored = await (await getApprovalMirrorStore()).findById(approvalId);
    if (!mirrored) return NextResponse.json({ error: 'No approval with this id' }, { status: 404 });
    const sibling = await (await getDriveEnvStore()).findLocalByEnvId(mirrored.envId);
    if (!sibling) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });

    // The OWNER only. No drive membership is consulted: this is the owner's own machine, wherever it is enrolled.
    if (sibling.ownerId !== auth.userId) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive_env', resourceId: mirrored.envId, details: { route: 'env-bridge/approvals', operation: 'revoke', approvalId, ownerId: sibling.ownerId }, riskScore: 0.3 });
      return NextResponse.json({ error: `Only this machine's owner (the user who enrolled it, ${sibling.ownerId}) can revoke an approval on it from account settings`, reason: 'not_owner', ownerId: sibling.ownerId }, { status: 403 });
    }

    const result = await revokeLocalEnvApproval({ envId: mirrored.envId, approvalId, reason: `revoked_by_${auth.userId}` });
    if (!result.ok) {
      if (result.reason === 'not_found') return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
      return NextResponse.json({ error: 'This environment has been revoked', reason: 'revoked' }, { status: 409 });
    }
    const machine = result.machine;
    await markEnvApprovalRevoked({ id: approvalId, by: auth.userId });
    if (machine.kind === 'acknowledged') await markEnvApprovalAcknowledged({ id: approvalId, removed: machine.removed });
    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'drive_env', resourceId: mirrored.envId, details: { route: 'env-bridge/approvals', operation: 'revoke', approvalId, machine: machine.kind, ...(machine.kind === 'acknowledged' && { removed: machine.removed }) } });
    if (machine.kind === 'acknowledged') return NextResponse.json({ revoked: true, machine: 'acknowledged', approvalId, removed: machine.removed });
    if (machine.kind === 'unacknowledged') {
      return NextResponse.json({ revoked: false, reason: 'unacknowledged', machine: machine.reason, error: 'The revoke was sent, but the machine did not acknowledge it in time; it may still hold this approval. It will be asked again when it reconnects.' }, { status: 202 });
    }
    return NextResponse.json({ revoked: false, reason: machine.kind, machine: machine.kind, error: 'The machine is not connected right now; the revoke is recorded and will be delivered when it reconnects, before it runs anything.' }, { status: 409 });
  } catch (error) {
    loggers.api.error('Failed to revoke an environment approval from account settings', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to revoke the approval' }, { status: 500 });
  }
}
