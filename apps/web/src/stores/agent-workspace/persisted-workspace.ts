/**
 * Validates `localStorage`-rehydrated workspace state before it ever reaches
 * the store.
 *
 * `JSON.parse` on rehydration is untyped by construction — a previous schema
 * version, a browser extension, or plain storage corruption can all write
 * something the cast would have accepted and this app never would. Every
 * grid is validated with `persistedWorkspaceStateSchema` (the same schema the
 * server's `PUT .../workspace` route validates against — one declaration,
 * both boundaries) on the way in, and a grid that fails is DROPPED wholesale
 * rather than repaired: a half-valid layout is not
 * a layout worth keeping, and the session it names is still reachable from
 * its sidebar row (the grid just reopens on that session's first
 * conversation, same as a session with no persisted layout at all).
 *
 * This is the primary defense against a corrupt `kind` reaching
 * `resolvePaneSurface`; that module's own fallback (finding 6) is the second
 * one, for state this module never saw (a test, a future caller).
 */
import { persistedWorkspaceStateSchema } from '@pagespace/lib/agent-sessions/contract';
import type { WorkspaceState } from './pane-reducer';

/**
 * `persist`'s `merge` hook: `persisted` is whatever `JSON.parse`d value the
 * storage held (or `undefined`/garbage on a cold or foreign key). Returns
 * only the grids that pass validation, keyed by session id — using the
 * PARSED result, not the raw input: a grid written by a browser from before
 * pane tabs were removed still carries a `tabs` array on each pane in the raw
 * object, which `persistedPaneStateSchema` accepts but strips on parse. Using
 * the parsed result here is what keeps that stale field from ever reaching
 * the store.
 */
export function validatePersistedWorkspaces(persisted: unknown): Record<string, WorkspaceState> {
  if (persisted === null || typeof persisted !== 'object') return {};
  const candidate = (persisted as { workspaces?: unknown }).workspaces;
  if (candidate === null || typeof candidate !== 'object') return {};

  const result: Record<string, WorkspaceState> = {};
  for (const [sessionId, workspace] of Object.entries(candidate as Record<string, unknown>)) {
    const parsed = persistedWorkspaceStateSchema.safeParse(workspace);
    if (parsed.success) result[sessionId] = parsed.data as WorkspaceState;
  }
  return result;
}
