import {
  shellConnectPayloadSchema,
  type ShellConnectPayload,
} from '@pagespace/lib/agent-sessions/contract';

export type TerminalConnectPayload = { pageId: string; cols: number; rows: number };

type Ok = { ok: true; value: TerminalConnectPayload };
type Err = { ok: false; error: string };
type Result = Ok | Err;

export function validateTerminalConnectPayload(payload: unknown): Result {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: 'invalid payload' };
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.pageId !== 'string' || p.pageId.length === 0) {
    return { ok: false, error: 'invalid pageId' };
  }
  if (typeof p.cols !== 'number' || !Number.isFinite(p.cols) || p.cols <= 0) {
    return { ok: false, error: 'invalid cols' };
  }
  if (typeof p.rows !== 'number' || !Number.isFinite(p.rows) || p.rows <= 0) {
    return { ok: false, error: 'invalid rows' };
  }
  return { ok: true, value: { pageId: p.pageId, cols: p.cols, rows: p.rows } };
}

export type AgentTerminalConnectPayload = {
  machineId: string;
  /** Neither set → machine scope, projectName alone → project scope, both → branch scope (see `agent-terminals.ts`). */
  projectName?: string;
  branchName?: string;
  name: string;
  cols: number;
  rows: number;
  /**
   * Client-generated id distinguishing ONE pane's PTY stream from another
   * when several are multiplexed over the SAME socket (the Terminal
   * workspace's splittable panes — one socket per browser tab, not per
   * pane). Optional and falls back to the socket's own id in
   * `agent-terminal-handler.ts` — a caller that never sends more than one
   * concurrent agent-terminal connection per socket (every caller before
   * the splittable-panes UI) needs no change.
   */
  connectionId?: string;
};

type AgentOk = { ok: true; value: AgentTerminalConnectPayload };
type AgentResult = AgentOk | Err;

function requireNonEmptyString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: `invalid ${field}` };
  }
  return { ok: true, value };
}

/** Same as `requireNonEmptyString`, but a missing/null value is a valid "scope not targeted" signal rather than an error. */
function optionalNonEmptyString(value: unknown, field: string): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: `invalid ${field}` };
  }
  return { ok: true, value };
}

export function validateAgentTerminalConnectPayload(payload: unknown): AgentResult {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: 'invalid payload' };
  }
  const p = payload as Record<string, unknown>;

  const machineId = requireNonEmptyString(p.machineId, 'machineId');
  if (!machineId.ok) return machineId;
  const projectName = optionalNonEmptyString(p.projectName, 'projectName');
  if (!projectName.ok) return projectName;
  const branchName = optionalNonEmptyString(p.branchName, 'branchName');
  if (!branchName.ok) return branchName;
  const name = requireNonEmptyString(p.name, 'name');
  if (!name.ok) return name;
  const connectionId = optionalNonEmptyString(p.connectionId, 'connectionId');
  if (!connectionId.ok) return connectionId;

  if (typeof p.cols !== 'number' || !Number.isFinite(p.cols) || p.cols <= 0) {
    return { ok: false, error: 'invalid cols' };
  }
  if (typeof p.rows !== 'number' || !Number.isFinite(p.rows) || p.rows <= 0) {
    return { ok: false, error: 'invalid rows' };
  }

  return {
    ok: true,
    value: {
      machineId: machineId.value,
      projectName: projectName.value,
      branchName: branchName.value,
      name: name.value,
      cols: p.cols,
      rows: p.rows,
      connectionId: connectionId.value,
    },
  };
}

// ---------------------------------------------------------------------------
// shell:* connect payload — parsed with the SHARED contract schema
// ---------------------------------------------------------------------------

/**
 * Parse a `shell:connect` payload with the ONE shared contract schema
 * (`packages/lib/src/agent-sessions/contract.ts`) instead of a local shape:
 * web routes, this bridge, and the frontend all validate the same zod object,
 * so the wire shape cannot drift per surface. The schema strips unknown keys,
 * REJECTS nonsense dimensions (zero, negative, non-finite, non-numeric) and
 * CLAMPS out-of-range ones — so a parsed payload needs no further clamping.
 *
 * The local `AgentTerminalConnectPayload` shapes above serve only the legacy
 * `agent-terminal:*` family and are deleted with it in the Phase 8 sweep.
 */
export function parseShellConnectPayload(
  payload: unknown,
): { ok: true; value: ShellConnectPayload } | Err {
  const parsed = shellConnectPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('.');
    return { ok: false, error: path ? `invalid ${path}` : 'invalid payload' };
  }
  return { ok: true, value: parsed.data };
}

export const MIN_COLS = 10;
export const MIN_ROWS = 5;
export const MAX_COLS = 500;
export const MAX_ROWS = 200;

export function clampTerminalDimensions({ cols, rows }: { cols: number; rows: number }): { cols: number; rows: number } {
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(cols))),
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(rows))),
  };
}
