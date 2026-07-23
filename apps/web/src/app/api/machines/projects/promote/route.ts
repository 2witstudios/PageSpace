/**
 * Machine Project PROMOTION API — give a project its OWN Sprite (issue #2204
 * phase 7, `machine-project-promotion.ts`).
 *
 * POST { machineId, name, carryDirty? } → promote (provision + clone + credential + CAS)
 *
 * The explicit entry point for lazy promotion: a project stays a checkout on
 * the owning Machine's Sprite until something promotes it, and this is the
 * surface a human (navigator UI) or an operator uses to do that on demand.
 * Everything downstream — the agent tool cascade and the realtime PTY bridge —
 * flips to the project's own Sprite automatically once the row says it is
 * promoted; nothing else has to be told.
 *
 * Session-only and EDIT-level, matching the sibling projects/branches writes:
 * promotion provisions a billable VM and rewrites where a project lives.
 *
 * `name` is FREE TEXT, normalized server-side exactly as `addProject`
 * normalized it before persisting, so whatever text created a project can also
 * promote it.
 *
 * `carryDirty` (issue #2207) is the migration path out of the dirty/unpushed
 * refusals: it bundles the machine-side work and restores it on the promoted
 * Sprite. THIS ROUTE IS ITS ONLY SURFACE — the implicit spawn path deliberately
 * keeps refusing, because relocating someone's uncommitted work is a decision
 * they have to make, not a side effect of opening a terminal.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { promoteProject } from '@pagespace/lib/services/machines/machine-project-promotion';
import { hasNameContent } from '@pagespace/lib/services/machines/name-slug';
import {
  buildPromoteProjectDeps,
  canAccessMachine,
  resolveMachineActorContext,
} from '@/lib/machines/machine-projects-runtime';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const PROMOTE_DENIAL_STATUS: Record<string, number> = {
  project_not_found: 404,
  // A refusal the CALLER can fix (commit or discard the work) — 409, not 400.
  dirty_checkout: 409,
  // Likewise fixable, by pushing or by retrying with `carryDirty` — it is not a
  // server fault, and without this entry it fell through to a misleading 500.
  unpushed_commits: 409,
  // The work is too big to carry; pushing and promoting without a carry works.
  carry_too_large: 409,
  // The carry itself broke down inside the sandbox — nothing was promoted.
  carry_failed: 502,
  // We could not verify the checkout is clean; retrying later may succeed.
  dirty_check_failed: 409,
  kill_switch_off: 503,
  containment_unverified: 503,
  clone_failed: 502,
  provision_failed: 502,
  error: 500,
};

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { machineId?: unknown; name?: unknown; carryDirty?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.machineId !== 'string' || body.machineId.length === 0) {
    return NextResponse.json({ error: 'machineId is required' }, { status: 400 });
  }
  // Same line the add/remove routes draw: a NAMELESS name is a missing field,
  // not free text to normalize (`"   "`, `"."`, `".."` all collapse to the same
  // fallback slug).
  if (typeof body.name !== 'string' || !hasNameContent(body.name)) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  // Strictly boolean: a truthy string like "no" would opt a caller into MOVING
  // their uncommitted work without them ever having said yes.
  if (body.carryDirty !== undefined && typeof body.carryDirty !== 'boolean') {
    return NextResponse.json({ error: 'carryDirty must be a boolean' }, { status: 400 });
  }

  if (!(await canAccessMachine(auth.userId, body.machineId))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const actor = await resolveMachineActorContext(auth.userId);
  const deps = buildPromoteProjectDeps({ actorUserId: auth.userId });

  const result = await promoteProject({
    machineId: body.machineId,
    projectName: body.name,
    actor,
    carryDirty: body.carryDirty === true,
    deps,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.detail ?? result.reason, reason: result.reason },
      { status: PROMOTE_DENIAL_STATUS[result.reason] ?? 500 },
    );
  }

  return NextResponse.json({
    sandboxId: result.sandboxId,
    // `false` when the project was ALREADY promoted and this call just
    // reattached — the caller should render "already on its own sandbox",
    // not "promoted just now".
    promoted: result.promoted,
    resumed: result.resumed,
    // `true` when work was moved across — the caller should tell the user their
    // changes are waiting UNCOMMITTED on the new Sprite.
    carried: result.carried,
  });
}
