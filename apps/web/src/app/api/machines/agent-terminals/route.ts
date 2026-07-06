/**
 * Agent Terminals API — the navigator UI's surface onto a branch-terminal's
 * named, pluggable-agent-typed PTY sessions (Terminal — Workspace, Runtime
 * tier).
 *
 * GET    ?terminalId=&projectName=&branchName=                       → list
 * POST   { terminalId, projectName, branchName, name, agentType }    → spawn (reserves the session; PTY opens lazily on first realtime connect)
 * DELETE ?terminalId=&projectName=&branchName=&name=                 → kill (tears down the PTY if running, drops the tracking row)
 *
 * Session-only (no MCP/agent tokens) — this is a human/UI surface. Every
 * request re-checks access for the OWNING Machine page (view-level for GET,
 * edit-level for POST/DELETE), same as the Branches API.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { spawnAgentTerminal, killAgentTerminal, listAgentTerminals } from '@pagespace/lib/services/machines/agent-terminals';
import {
  buildSpawnAgentTerminalDeps,
  buildKillAgentTerminalDeps,
  buildListAgentTerminalsDeps,
  canAccessMachine,
  canViewMachine,
} from '@/lib/machines/agent-terminals-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

function requireString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: NextResponse } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: NextResponse.json({ error: `${field} is required` }, { status: 400 }) };
  }
  return { ok: true, value };
}

const SPAWN_DENIAL_STATUS: Record<string, number> = {
  invalid_name: 400,
  invalid_agent_type: 400,
  branch_not_found: 404,
  name_in_use: 409,
  error: 500,
};

const KILL_DENIAL_STATUS: Record<string, number> = {
  branch_not_found: 404,
  not_found: 404,
  error: 500,
};

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const terminalId = requireString(url.searchParams.get('terminalId'), 'terminalId');
  if (!terminalId.ok) return terminalId.error;
  const projectName = requireString(url.searchParams.get('projectName'), 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = requireString(url.searchParams.get('branchName'), 'branchName');
  if (!branchName.ok) return branchName.error;

  if (!(await canViewMachine(auth.userId, terminalId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const result = await listAgentTerminals({
    terminalId: terminalId.value,
    projectName: projectName.value,
    branchName: branchName.value,
    deps: buildListAgentTerminalsDeps(),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 404 });
  }
  return NextResponse.json({
    agentTerminals: result.terminals.map((t) => ({ name: t.name, agentType: t.agentType, createdAt: t.createdAt })),
  });
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { terminalId?: unknown; projectName?: unknown; branchName?: unknown; name?: unknown; agentType?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const terminalId = requireString(body.terminalId, 'terminalId');
  if (!terminalId.ok) return terminalId.error;
  const projectName = requireString(body.projectName, 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = requireString(body.branchName, 'branchName');
  if (!branchName.ok) return branchName.error;
  const name = requireString(body.name, 'name');
  if (!name.ok) return name.error;
  const agentType = requireString(body.agentType, 'agentType');
  if (!agentType.ok) return agentType.error;

  if (!(await canAccessMachine(auth.userId, terminalId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const result = await spawnAgentTerminal({
    terminalId: terminalId.value,
    projectName: projectName.value,
    branchName: branchName.value,
    name: name.value,
    agentType: agentType.value,
    actor: { userId: auth.userId },
    deps: buildSpawnAgentTerminalDeps(),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason, reason: result.reason }, { status: SPAWN_DENIAL_STATUS[result.reason] ?? 500 });
  }
  return NextResponse.json(
    { agentTerminal: { name: name.value, agentType: result.agentType, resumed: result.resumed } },
    { status: result.resumed ? 200 : 201 },
  );
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const terminalId = requireString(url.searchParams.get('terminalId'), 'terminalId');
  if (!terminalId.ok) return terminalId.error;
  const projectName = requireString(url.searchParams.get('projectName'), 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = requireString(url.searchParams.get('branchName'), 'branchName');
  if (!branchName.ok) return branchName.error;
  const name = requireString(url.searchParams.get('name'), 'name');
  if (!name.ok) return name.error;

  if (!(await canAccessMachine(auth.userId, terminalId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const result = await killAgentTerminal({
    terminalId: terminalId.value,
    projectName: projectName.value,
    branchName: branchName.value,
    name: name.value,
    deps: await buildKillAgentTerminalDeps(),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: KILL_DENIAL_STATUS[result.reason] ?? 500 });
  }
  return NextResponse.json({ success: true });
}
