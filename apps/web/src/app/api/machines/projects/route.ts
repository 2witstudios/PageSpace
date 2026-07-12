/**
 * Machine Projects API — the navigator UI's surface onto a Machine's git
 * repos (Terminal — Workspace, Projects tier).
 *
 * GET    ?machineId=<id>                        → list
 * POST   { machineId, name, repoUrl }            → add (clones)
 * DELETE ?machineId=&name=                       → remove
 *
 * A Machine's identity is its backing Terminal page (`machineId`) — the
 * SAME persistent Sprite session a live Terminal shell already uses.
 * Session-only (no MCP/agent tokens) — this is a human/UI surface; the agent
 * has its own `git_clone` tool. Every request re-checks access for the named
 * page (view-level for GET, edit-level for POST/DELETE).
 *
 * `name` on POST is FREE TEXT. The server normalizes it into a valid directory
 * slug (`normalizeProjectName`, inside `addProject`) rather than rejecting it,
 * and the response echoes the canonical name — clients should render THAT, not
 * what the user typed. (A client-side live preview of the same normalization is
 * a separate follow-up; it would be a convenience, never the authority.)
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { addProject, listProjects, removeProject } from '@pagespace/lib/services/machines/machine-projects';
import { hasNameContent } from '@pagespace/lib/services/machines/name-slug';
import {
  buildMachineProjectsDeps,
  canAccessMachine,
  canViewMachine,
  resolveMachineActorContext,
} from '@/lib/machines/machine-projects-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

function requireMachineId(machineId: unknown): { ok: true; machineId: string } | { ok: false; error: NextResponse } {
  if (typeof machineId !== 'string' || machineId.length === 0) {
    return { ok: false, error: NextResponse.json({ error: 'machineId is required' }, { status: 400 }) };
  }
  return { ok: true, machineId };
}

const ADD_PROJECT_DENIAL_STATUS: Record<string, number> = {
  invalid_name: 400,
  invalid_repo_url: 400,
  duplicate_name: 409,
  kill_switch_off: 503,
  clone_failed: 502,
  error: 500,
};

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const parsed = requireMachineId(url.searchParams.get('machineId'));
  if (!parsed.ok) return parsed.error;

  if (!(await canViewMachine(auth.userId, parsed.machineId))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const deps = buildMachineProjectsDeps({ actorUserId: auth.userId });
  const projects = await listProjects({ machineId: parsed.machineId, store: deps.store });
  return NextResponse.json({
    projects: projects.map((p) => ({ name: p.name, repoUrl: p.repoUrl, path: p.path, createdAt: p.createdAt })),
  });
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { machineId?: unknown; name?: unknown; repoUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = requireMachineId(body.machineId);
  if (!parsed.ok) return parsed.error;

  // A NAMELESS name is a MISSING field, not free text to be normalized — accepting
  // it would silently clone the repo into a directory called `project`. And
  // "nameless" is broader than "blank": `"   "`, `"."`, `".."` and `"//"` all
  // normalize to that same fallback, so the guard uses the normalizer's own
  // `hasNameContent` rather than a `.trim()` that only catches whitespace. The
  // branches route draws the same line (`requireName`).
  if (typeof body.name !== 'string' || !hasNameContent(body.name) || typeof body.repoUrl !== 'string') {
    return NextResponse.json({ error: 'name and repoUrl are required non-empty strings' }, { status: 400 });
  }

  if (!(await canAccessMachine(auth.userId, parsed.machineId))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const [actor, deps] = [
    await resolveMachineActorContext(auth.userId),
    buildMachineProjectsDeps({ actorUserId: auth.userId }),
  ];

  const result = await addProject({ machineId: parsed.machineId, actor, name: body.name, repoUrl: body.repoUrl, deps });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.detail ?? result.reason, reason: result.reason },
      { status: ADD_PROJECT_DENIAL_STATUS[result.reason] ?? 500 },
    );
  }
  return NextResponse.json(
    { project: { name: result.project.name, repoUrl: result.project.repoUrl, path: result.project.path } },
    { status: 201 },
  );
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const parsed = requireMachineId(url.searchParams.get('machineId'));
  if (!parsed.ok) return parsed.error;

  // This guard matters MORE than the one on POST: `removeProject` normalizes its
  // lookup key, so a nameless `?name=` resolves to the FALLBACK and would `rm -rf`
  // a real project called `project`. `..` and `//` are nameless too, not just
  // whitespace — hence `hasNameContent` and not `.trim()`.
  const name = url.searchParams.get('name');
  if (!name || !hasNameContent(name)) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  if (!(await canAccessMachine(auth.userId, parsed.machineId))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const deps = buildMachineProjectsDeps({ actorUserId: auth.userId });
  const result = await removeProject({ machineId: parsed.machineId, name, deps });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.reason === 'not_found' ? 404 : 500 });
  }
  return NextResponse.json({ success: true });
}
