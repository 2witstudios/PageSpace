/**
 * Machine Projects API — the navigator UI's surface onto a Machine's git
 * repos (Terminal — Workspace, Projects tier).
 *
 * GET    ?terminalId=<id>                        → list
 * POST   { terminalId, name, repoUrl }            → add (clones)
 * DELETE ?terminalId=&name=                       → remove
 *
 * A Machine's identity is its backing Terminal page (`terminalId`) — the
 * SAME persistent Sprite session a live Terminal shell already uses.
 * Session-only (no MCP/agent tokens) — this is a human/UI surface; the agent
 * has its own `git_clone` tool. Every request re-checks access for the named
 * page (view-level for GET, edit-level for POST/DELETE).
 */

import { NextResponse } from 'next/server';
import { addProject, listProjects, removeProject } from '@pagespace/lib/services/machines/machine-projects';
import {
  buildMachineProjectsDeps,
  canAccessMachine,
  canViewMachine,
  resolveMachineActorContext,
} from '@/lib/machines/machine-projects-runtime';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

function requireTerminalId(terminalId: unknown): { ok: true; terminalId: string } | { ok: false; error: NextResponse } {
  if (typeof terminalId !== 'string' || terminalId.length === 0) {
    return { ok: false, error: NextResponse.json({ error: 'terminalId is required' }, { status: 400 }) };
  }
  return { ok: true, terminalId };
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
  const parsed = requireTerminalId(url.searchParams.get('terminalId'));
  if (!parsed.ok) return parsed.error;

  if (!(await canViewMachine(auth.userId, parsed.terminalId))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const deps = buildMachineProjectsDeps({ actorUserId: auth.userId });
  const projects = await listProjects({ terminalId: parsed.terminalId, store: deps.store });
  return NextResponse.json({
    projects: projects.map((p) => ({ name: p.name, repoUrl: p.repoUrl, path: p.path, createdAt: p.createdAt })),
  });
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { terminalId?: unknown; name?: unknown; repoUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = requireTerminalId(body.terminalId);
  if (!parsed.ok) return parsed.error;

  if (typeof body.name !== 'string' || typeof body.repoUrl !== 'string') {
    return NextResponse.json({ error: 'name and repoUrl are required strings' }, { status: 400 });
  }

  if (!(await canAccessMachine(auth.userId, parsed.terminalId))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const [actor, deps] = [
    await resolveMachineActorContext(auth.userId),
    buildMachineProjectsDeps({ actorUserId: auth.userId }),
  ];

  const result = await addProject({ terminalId: parsed.terminalId, actor, name: body.name, repoUrl: body.repoUrl, deps });
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
  const parsed = requireTerminalId(url.searchParams.get('terminalId'));
  if (!parsed.ok) return parsed.error;

  const name = url.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  if (!(await canAccessMachine(auth.userId, parsed.terminalId))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const deps = buildMachineProjectsDeps({ actorUserId: auth.userId });
  const result = await removeProject({ terminalId: parsed.terminalId, name, deps });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.reason === 'not_found' ? 404 : 500 });
  }
  return NextResponse.json({ success: true });
}
