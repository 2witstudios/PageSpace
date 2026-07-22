/**
 * Agent Terminals API — the navigator UI's surface onto a Terminal-scope
 * (machine/project/branch — see `agent-terminals.ts`), named, pluggable-
 * agent-typed PTY sessions (Terminal — Workspace, Runtime tier).
 *
 * GET    ?machineId=[&projectName=][&branchName=]                              → list
 * POST   { machineId, [projectName], [branchName], name, agentType, [command] } → spawn (reserves the session; PTY opens lazily on first realtime connect)
 * DELETE ?machineId=[&projectName=][&branchName=]&name=                        → kill (tears down the PTY if running, drops the tracking row)
 *
 * `projectName`/`branchName` are OPTIONAL on every verb — neither set targets
 * machine scope, `projectName` alone targets project scope, both target
 * branch scope; `branchName` alone (no `projectName`) is a malformed target
 * (`invalid_target`, 400) since a branch always belongs to a named project.
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
  isCodeExecutionEnabled,
} from '@/lib/machines/agent-terminals-runtime';
import { conversationRepository } from '@/lib/repositories/conversation-repository';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

function requireString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: NextResponse } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: NextResponse.json({ error: `${field} is required` }, { status: 400 }) };
  }
  return { ok: true, value };
}

/** Same as `requireString`, but a missing/null value is a valid "scope not targeted" signal rather than an error. */
function optionalString(value: unknown, field: string): { ok: true; value: string | undefined } | { ok: false; error: NextResponse } {
  if (value === null || value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: NextResponse.json({ error: `${field} must be a non-empty string when provided` }, { status: 400 }) };
  }
  return { ok: true, value };
}

const SCOPE_DENIAL_STATUS: Record<string, number> = {
  invalid_target: 400,
  project_not_found: 404,
  branch_not_found: 404,
  machine_unavailable: 503,
  scope_unsupported: 503,
};

const SPAWN_DENIAL_STATUS: Record<string, number> = {
  ...SCOPE_DENIAL_STATUS,
  invalid_name: 400,
  invalid_agent_type: 400,
  invalid_command: 400,
  name_in_use: 409,
  // A promotion refusal the caller can act on (commit or discard the work in
  // the machine-side checkout), matching the promote route's own mapping.
  promotion_failed: 409,
  error: 500,
};

const KILL_DENIAL_STATUS: Record<string, number> = {
  ...SCOPE_DENIAL_STATUS,
  not_found: 404,
  not_a_pty_agent: 409,
  error: 500,
};

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const machineId = requireString(url.searchParams.get('machineId'), 'machineId');
  if (!machineId.ok) return machineId.error;
  const projectName = optionalString(url.searchParams.get('projectName'), 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = optionalString(url.searchParams.get('branchName'), 'branchName');
  if (!branchName.ok) return branchName.error;

  if (!(await canViewMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const result = await listAgentTerminals({
    machineId: machineId.value,
    projectName: projectName.value,
    branchName: branchName.value,
    deps: buildListAgentTerminalsDeps(),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: SCOPE_DENIAL_STATUS[result.reason] ?? 500 });
  }
  return NextResponse.json({
    agentTerminals: result.terminals.map((t) => ({ id: t.id, name: t.name, agentType: t.agentType, createdAt: t.createdAt })),
  });
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { machineId?: unknown; projectName?: unknown; branchName?: unknown; name?: unknown; agentType?: unknown; command?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const machineId = requireString(body.machineId, 'machineId');
  if (!machineId.ok) return machineId.error;
  const projectName = optionalString(body.projectName, 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = optionalString(body.branchName, 'branchName');
  if (!branchName.ok) return branchName.error;
  const name = requireString(body.name, 'name');
  if (!name.ok) return name.error;
  const agentType = requireString(body.agentType, 'agentType');
  if (!agentType.ok) return agentType.error;
  const command = optionalString(body.command, 'command');
  if (!command.ok) return command.error;

  // `pagespace` renders the PageSpace AI chat UI rather than a real PTY — refuse it
  // up front, before any DB access check, when the code-execution kill switch is off.
  if (agentType.value === 'pagespace' && !isCodeExecutionEnabled()) {
    return NextResponse.json({ error: 'code_execution_disabled', reason: 'code_execution_disabled' }, { status: 403 });
  }

  if (!(await canAccessMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const result = await spawnAgentTerminal({
    machineId: machineId.value,
    projectName: projectName.value,
    branchName: branchName.value,
    name: name.value,
    agentType: agentType.value,
    command: command.value,
    actor: { userId: auth.userId },
    deps: buildSpawnAgentTerminalDeps(auth.userId),
  });
  if (!result.ok) {
    // `detail` carries a promotion refusal's actionable message (which file is
    // dirty, what to do about it) — surfacing only the bare reason would leave
    // the user with an unexplained 409.
    return NextResponse.json(
      { error: result.detail ?? result.reason, reason: result.reason },
      { status: SPAWN_DENIAL_STATUS[result.reason] ?? 500 },
    );
  }

  // A fresh `pagespace` row needs its shared conversation to exist before the client's
  // first message so co-editors get multi-viewer parity from the start. A resumed
  // spawn reattaches to whatever the original fresh spawn already created. Non-fatal:
  // a failed pre-create just means the row gets created lazily on first message instead.
  if (agentType.value === 'pagespace' && !result.resumed) {
    try {
      await conversationRepository.createConversation(result.id, auth.userId, machineId.value, { isShared: true });
    } catch {
      // Non-fatal — see comment above.
    }
  }

  return NextResponse.json(
    { agentTerminal: { id: result.id, name: name.value, agentType: result.agentType, resumed: result.resumed } },
    { status: result.resumed ? 200 : 201 },
  );
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const machineId = requireString(url.searchParams.get('machineId'), 'machineId');
  if (!machineId.ok) return machineId.error;
  const projectName = optionalString(url.searchParams.get('projectName'), 'projectName');
  if (!projectName.ok) return projectName.error;
  const branchName = optionalString(url.searchParams.get('branchName'), 'branchName');
  if (!branchName.ok) return branchName.error;
  const name = requireString(url.searchParams.get('name'), 'name');
  if (!name.ok) return name.error;

  if (!(await canAccessMachine(auth.userId, machineId.value))) {
    return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
  }

  const result = await killAgentTerminal({
    machineId: machineId.value,
    projectName: projectName.value,
    branchName: branchName.value,
    name: name.value,
    deps: await buildKillAgentTerminalDeps(auth.userId),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: KILL_DENIAL_STATUS[result.reason] ?? 500 });
  }
  return NextResponse.json({ success: true });
}
