import {
  shellConnectPayloadSchema,
  type ShellConnectPayload,
} from '@pagespace/lib/agent-workspaces/shells-contract';

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

// ---------------------------------------------------------------------------
// shell:* connect payload — parsed with the SHARED contract schema
// ---------------------------------------------------------------------------

/**
 * Parse a `shell:connect` payload with the ONE shared contract schema
 * (`packages/lib/src/agent-workspaces/contract.ts`) instead of a local shape:
 * web routes, this bridge, and the frontend all validate the same zod object,
 * so the wire shape cannot drift per surface. The schema strips unknown keys,
 * REJECTS nonsense dimensions (zero, negative, non-finite, non-numeric) and
 * CLAMPS out-of-range ones — so a parsed payload needs no further clamping.
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
