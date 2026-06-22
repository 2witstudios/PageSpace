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
  if (typeof p.cols !== 'number' || p.cols <= 0) {
    return { ok: false, error: 'invalid cols' };
  }
  if (typeof p.rows !== 'number' || p.rows <= 0) {
    return { ok: false, error: 'invalid rows' };
  }
  return { ok: true, value: { pageId: p.pageId, cols: p.cols, rows: p.rows } };
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
