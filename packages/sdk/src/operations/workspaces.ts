/**
 * Workspace shell operations: `workspaces.list` and `workspaces.exec`.
 *
 * Route-verified against `apps/web/src/app/api/agent-workspaces/route.ts` GET
 * (the caller's own workspaces, filtered to the credential's drive scope) and
 * `apps/web/src/app/api/agent-workspaces/[workspaceId]/exec/route.ts` POST —
 * the chat `bash` tool made reachable by token: same input schema, same gate
 * (kill switch, `canRunCode`, quota), same runner (command/path policy,
 * billing, audit). A cold workspace is provisioned on first exec.
 *
 * A non-zero `exitCode` is a SUCCESS response — the command ran. Only a refusal
 * is an HTTP error (`{ error, reason, retryAfter? }`); an unreachable, denied,
 * out-of-scope or ended workspace is always a 404.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

/** Mirrors the web tool's `bashInputSchema` limit (`MAX_PATH_LENGTH`). */
const MAX_PATH_LENGTH = 1024;

/** The fields a shell client needs; the route sends more (shells, conversations, nodes), passed through untouched. */
const workspaceSchema = z.looseObject({
  workspaceId: z.string(),
  driveId: z.string().nullable(),
  ownerId: z.string(),
  name: z.string(),
  envId: z.string().nullable(),
  sandboxStatus: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});

export const listWorkspaces = defineOperation({
  name: 'workspaces.list',
  method: 'GET',
  path: '/api/agent-workspaces',
  inputSchema: z.strictObject({ driveId: z.string().optional() }),
  outputSchema: z.object({ sessions: z.array(workspaceSchema) }),
  requiredScope: 'drive',
  description:
    "List the caller's agent workspaces (optionally narrowed to one drive). Each workspace has ONE sandbox shared by its shells and conversations; pass its workspaceId to workspaces.exec to run a command there. A drive-scoped token only sees workspaces inside its drives.",
});

export const execInWorkspace = defineOperation({
  name: 'workspaces.exec',
  method: 'POST',
  path: '/api/agent-workspaces/:workspaceId/exec',
  inputSchema: z.strictObject({
    workspaceId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().max(MAX_PATH_LENGTH).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    truncated: z.boolean(),
  }),
  requiredScope: 'drive',
  // The server clamps a run to 200s (SANDBOX_MAX_TIMEOUT_MS) and a cold
  // workspace provisions its sandbox first; the client must outlast both.
  timeoutMsOverride: 260_000,
  description:
    "Run a shell command in a workspace's sandbox (provisioned on first use). Returns stdout, stderr and exitCode — a non-zero exitCode is still a successful call. cwd is relative to the sandbox root and cannot escape it; timeoutMs (default 120000) is clamped to 200000. The filesystem persists across calls and is shared with the workspace's shells and agents.",
});
