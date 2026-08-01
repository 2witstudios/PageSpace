/**
 * Syncs one session's pane grid — layout AND tabs — to the server, so a
 * refresh or a different device restores the same panes instead of the
 * ephemeral browser-only layout this subsystem started as.
 *
 * DEBOUNCED, not per-transition: an earlier "machine workspace" version
 * synced eagerly and was torn down for making every split a write
 * (`pane-reducer.ts`'s file header). This hook instead subscribes to the
 * store's own `workspaces[sessionId]` value and schedules ONE save after
 * activity settles — adapted from `usePageContent.ts`'s
 * save/performSave/forceSave triple (debounce + in-flight race guard +
 * force-flush-on-unmount + `useEditingStore` coordination), swapping a
 * single string payload for the serialized grid.
 *
 * Passive by design: this hook never calls a reducer transition itself. Every
 * mutation (split, switch, tab close, the tool-driven `open_page_pane` path)
 * already happens through the store from wherever it's triggered; this hook
 * only OBSERVES the result and persists it.
 */
import { useCallback, useEffect, useId, useRef } from 'react';
import { persistedWorkspaceStateSchema } from '@pagespace/lib/agent-sessions/contract';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useAgentWorkspaceStore } from './useAgentWorkspaceStore';
import type { WorkspaceState } from './pane-reducer';

const DEFAULT_DEBOUNCE_MS = 1500;

// Sessions already hydrated once THIS page load. Module-level, not a
// per-mount ref: `AgentPanes` is rendered `key={selectedSessionId}`
// (`AgentsSurface.tsx`), so switching to another session and back is a
// FRESH mount every time — a per-mount ref would reopen the server-wins
// hydration window (see the hydration effect below) on every single
// session switch, not just once per page load (review finding from an
// independent audit of the fix that removed the reference-equality guard).
const hydratedSessionsThisPageLoad = new Set<string>();

function workspaceUrl(sessionId: string): string {
  return `/api/agent-sessions/${encodeURIComponent(sessionId)}/workspace`;
}

/** Test-only: a real page load never needs to forget this — tests, run in one shared module scope, do. */
export function __resetHydratedSessionsForTests(): void {
  hydratedSessionsThisPageLoad.clear();
}

export function useWorkspaceServerSync(
  sessionId: string,
  options?: { enabled?: boolean; debounceMs?: number },
): void {
  const enabled = options?.enabled ?? true;
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const workspace = useAgentWorkspaceStore((state) => (enabled ? state.workspaces[sessionId] : undefined));
  const hydrateWorkspace = useAgentWorkspaceStore((state) => state.hydrateWorkspace);

  const pendingRef = useRef<WorkspaceState | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set right before a hydration write, so the debounce effect's next run
  // (triggered by that very write) knows there is nothing NEW to persist —
  // the server is already holding exactly what was just written.
  const justHydratedRef = useRef(false);
  // A purely local identifier for `useEditingStore` bookkeeping — `useId()`,
  // not the domain `createId()` (`@paralleldrive/cuid2`): this is never a
  // conversation/session id, and sharing that generator would (and in
  // testing, did) shift the numbering every OTHER caller of it expects.
  const syncId = useId();

  const performSave = useCallback(
    async (toSave: WorkspaceState) => {
      useEditingStore.getState().startEditing(syncId, 'other', { componentName: `workspace-sync:${sessionId}` });
      try {
        const response = await fetchWithAuth(workspaceUrl(sessionId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace: toSave }),
        });
        // A non-2xx (400/403/502/…) is a failed save, not a completed one —
        // leave it pending so the next mutation or the unmount flush retries
        // it, instead of silently dropping the layout.
        if (!response.ok) return;
        // Only clear pending if no newer layout arrived while this save was in-flight.
        if (pendingRef.current === toSave) pendingRef.current = null;
      } catch {
        // silent — the next mutation reschedules a save that includes this one's changes
      } finally {
        useEditingStore.getState().endEditing(syncId);
      }
    },
    [sessionId, syncId],
  );

  // Debounced save on every observed change.
  useEffect(() => {
    if (!enabled || !workspace) return;
    if (justHydratedRef.current) {
      justHydratedRef.current = false;
      return;
    }
    pendingRef.current = workspace;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (pendingRef.current) void performSave(pendingRef.current);
    }, debounceMs);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [enabled, workspace, debounceMs, performSave]);

  // Hydrate once per session PER PAGE LOAD from the server — unconditionally,
  // by design (see file header: "Server response wins over any stale
  // localStorage seed"). The mount-time `openConversation`/`ensureWorkspace`
  // seeding this hook's caller does (selecting the initial conversation, or
  // defaulting a brand-new session to one pane) always runs in the SAME
  // commit as this effect, before the fetch below resolves — so a
  // reference-equality guard here would see that local seed as "something
  // moved on" and skip hydration on effectively every mount, defeating
  // cross-device restore entirely (review finding). The narrow risk this
  // trades away — a genuine user edit landing in the single round-trip
  // before hydration resolves gets overwritten — is accepted, same as any
  // other server-wins seed. "Once per page load" (not once per mount) is
  // load-bearing here: only marked hydrated on a settled (not cancelled)
  // fetch, so a session switched away from mid-request retries cleanly on
  // its next mount instead of getting stuck un-hydrated for the rest of the
  // page's life.
  useEffect(() => {
    if (!enabled) return;
    if (hydratedSessionsThisPageLoad.has(sessionId)) return;

    let cancelled = false;

    fetchWithAuth(workspaceUrl(sessionId))
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { workspace?: unknown } | null) => {
        if (cancelled) return;
        hydratedSessionsThisPageLoad.add(sessionId);
        if (!json?.workspace) return;
        const parsed = persistedWorkspaceStateSchema.safeParse(json.workspace);
        if (!parsed.success) return;
        justHydratedRef.current = true;
        hydrateWorkspace(sessionId, parsed.data);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId, hydrateWorkspace]);

  // Force-flush on unmount (or session/enabled change) — a pending debounced
  // save must not evaporate when the grid closes before it fires.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = null;
      useEditingStore.getState().startEditing(syncId, 'other', { componentName: `workspace-sync:${sessionId}` });
      fetchWithAuth(workspaceUrl(sessionId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: pending }),
      })
        .catch(() => {})
        .finally(() => useEditingStore.getState().endEditing(syncId));
    };
  }, [enabled, sessionId, syncId]);
}
