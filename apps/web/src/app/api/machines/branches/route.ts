/**
 * Machine Branches API — the navigator UI's surface onto a Project's
 * branch-terminals (Terminal — Workspace, Branches tier).
 *
 * GET    ?machineId=&projectName=                       → list
 * POST   { machineId, projectName, branchName }         → spawn (provisions its OWN Sprite, clones, checks out)
 * DELETE ?machineId=&projectName=&branchName=           → kill (DELETEs the Sprite, drops the tracking row)
 *
 * Session-only (no MCP/agent tokens) — this is a human/UI surface. Every
 * request re-checks access for the named Machine page (view-level for GET,
 * edit-level for POST/DELETE).
 *
 * `branchName` on POST is FREE TEXT. The server normalizes it into a valid git
 * ref (`normalizeBranchName`, inside `spawnBranch`) rather than rejecting it,
 * and the response echoes the canonical name — clients should render THAT, not
 * what the user typed. (A client-side live preview of the same normalization is
 * a separate follow-up; it would be a convenience, never the authority.)
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { spawnBranch, killBranch, listBranches } from '@pagespace/lib/services/machines/machine-branches';
import { hasNameContent } from '@pagespace/lib/services/machines/name-slug';
import {
  buildMachineBranchesDeps,
  canAccessMachine,
  canViewMachine,
  getMachineHostForBranches,
  resolveMachineActorContext,
} from '@/lib/machines/machine-branches-runtime';
import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/** Not named `Required` — that shadows the TS built-in utility type. */
type ParsedField<T> = { ok: true; value: T } | { ok: false; error: NextResponse };

function fieldRequired(field: string): NextResponse {
  return NextResponse.json({ error: `${field} is required` }, { status: 400 });
}

/** An opaque id — not free text, so it is never normalized and needs no name predicate. */
function requireId(value: unknown, field: string): ParsedField<string> {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, error: fieldRequired(field) };
  return { ok: true, value };
}

/**
 * A NAME. These ARE normalized, so the guard has to be the normalizer's own idea of
 * namelessness — not a `.trim()`, which only catches whitespace. `"   "`, `"."`,
 * `".."` and `"//"` all carry no name, yet every one of them normalizes to the
 * FALLBACK (`branch`) — which would then match a REAL branch called `branch` and
 * attach the caller to its Sprite, or kill it. A nameless value is a missing field.
 */
function requireName(value: unknown, field: string): ParsedField<string> {
  if (typeof value !== 'string' || !hasNameContent(value)) return { ok: false, error: fieldRequired(field) };
  return { ok: true, value };
}

const SPAWN_DENIAL_STATUS: Record<string, number> = {
  kill_switch_off: 503,
  project_not_found: 404,
  code_execution_disabled: 503,
  containment_unverified: 503,
  provision_failed: 502,
  clone_failed: 502,
  checkout_failed: 502,
  error: 500,
};

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const machineId = requireId(url.searchParams.get('machineId'), 'machineId');
  if (!machineId.ok) return machineId.error;
  const projectName = requireName(url.searchParams.get('projectName'), 'projectName');
  if (!projectName.ok) return projectName.error;

  if (!(await canViewMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const store = await createDbMachineBranchStore();
  const branches = await listBranches({ machineId: machineId.value, projectName: projectName.value, store });
  return NextResponse.json({
    branches: branches.map((b) => ({ branchName: b.branchName, createdAt: b.createdAt })),
  });
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { machineId?: unknown; projectName?: unknown; branchName?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const machineId = requireId(body.machineId, 'machineId');
  if (!machineId.ok) return machineId.error;
  const projectName = requireName(body.projectName, 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = requireName(body.branchName, 'branchName');
  if (!branchName.ok) return branchName.error;

  if (!(await canAccessMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const [actor, deps] = [await resolveMachineActorContext(auth.userId), buildMachineBranchesDeps()];

  const result = await spawnBranch({
    machineId: machineId.value,
    projectName: projectName.value,
    branchName: branchName.value,
    actor,
    deps,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.detail ?? result.reason, reason: result.reason },
      { status: SPAWN_DENIAL_STATUS[result.reason] ?? 500 },
    );
  }
  // Echo the NORMALIZED name `spawnBranch` actually checked out and persisted —
  // "My Cool Feature" in, `my-cool-feature` back — never the raw request text.
  // `createdNew` says whether this is a brand-new branch off the default HEAD or
  // an existing upstream one, so a normalized name that no longer matches an
  // upstream branch is a STATED outcome rather than a silent empty checkout.
  return NextResponse.json(
    { branch: { branchName: result.branchName, resumed: result.resumed, createdNew: result.createdNew } },
    { status: result.resumed ? 200 : 201 },
  );
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const machineId = requireId(url.searchParams.get('machineId'), 'machineId');
  if (!machineId.ok) return machineId.error;
  const projectName = requireName(url.searchParams.get('projectName'), 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = requireName(url.searchParams.get('branchName'), 'branchName');
  if (!branchName.ok) return branchName.error;

  if (!(await canAccessMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const store = await createDbMachineBranchStore();
  const host = await getMachineHostForBranches();
  const result = await killBranch({
    machineId: machineId.value,
    projectName: projectName.value,
    branchName: branchName.value,
    store,
    host,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.reason === 'not_found' ? 404 : 500 });
  }
  return NextResponse.json({ success: true });
}
