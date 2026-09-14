/**
 * Agent triggers are held from OAuth applications (point-guard ruling
 * 2026-09-14, pending Phase 2b and [D-15]).
 *
 * An agent trigger — a calendar event's `agentTrigger`, a task's agent trigger,
 * or completing a task whose completion trigger is armed — schedules or starts
 * an agent run that `lib/workflows/workflow-executor.ts` executes as the owning
 * user with no drive or role ceiling. Until that run carries the credential's
 * ceiling, an app acting within its granted drives must not be able to start
 * one. The rest of each route stays at mcp parity; `mcp_` key behaviour is
 * deliberately unchanged here (a separate decision).
 *
 * Pure: the caller works out what the input would do; this only decides.
 */
import { NextResponse } from 'next/server';
import type { AuthResult } from './index';

export interface AgentTriggerIntent {
  /** The input sets, replaces or clears an agent trigger (any agent-trigger field present). */
  readonly writesTrigger: boolean;
  /** The input would fire an armed agent trigger (e.g. completing its task). */
  readonly firesTrigger: boolean;
}

/**
 * Whether the hold applies to this principal at all — so a caller only pays for
 * the I/O that tells it whether an input would FIRE a trigger when it matters.
 */
export function appliesAgentTriggerHold(auth: AuthResult): boolean {
  return auth.tokenType === 'oauth';
}

/** A constant-shape 403 when an OAuth principal's input would write or fire an agent trigger; otherwise null. */
export function refuseOAuthAgentTrigger(auth: AuthResult, intent: AgentTriggerIntent): NextResponse | null {
  if (!appliesAgentTriggerHold(auth)) return null;
  if (!intent.writesTrigger && !intent.firesTrigger) return null;
  return NextResponse.json({ error: 'Agent triggers are not available to OAuth applications' }, { status: 403 });
}
