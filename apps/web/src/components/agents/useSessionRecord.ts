'use client';

/**
 * A session's own record — the authority on ITS drive. Never infer a
 * session's drive from a hosted page's own drive, or a UI's mount-time drive
 * context: a session can be global (`driveId` null) while hosting a
 * drive-scoped agent's conversation, or drive-scoped while hosting the global
 * assistant (`create-conversation-in-session.ts`) — the two can diverge, and
 * only the session's own record is truthful about which.
 *
 * `session: null` means the id doesn't resolve to one the caller may see
 * (never existed, ended elsewhere, reaped, or someone else's) — every caller
 * decides for itself what that means (e.g. `AgentsSurface` forgets its
 * persisted grid; `AgentPageView` falls back to the hosted page's own drive).
 *
 * Shared by every reader of a single session's record so the fetch shape and
 * caching policy (`revalidateOnFocus: false` — a session's drive is
 * effectively static, not worth refetching on every window focus;
 * `dedupingInterval: 30_000`) can't drift between call sites.
 */
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export interface SessionRecordSummary {
  driveId: string | null;
  name: string;
}

export interface SessionRecordResponse {
  session: SessionRecordSummary | null;
  /**
   * Whether this session's PAYER (drive owner, or the session's own owner
   * when driveless) is on a tier that includes the sandbox — server-resolved,
   * since the client only knows the viewing user's own tier, the wrong axis
   * for a shared drive. `undefined` when `session` is null (nothing to
   * resolve a payer against).
   */
  sandboxEligible?: boolean;
}

async function sessionFetcher(url: string): Promise<SessionRecordResponse> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to load session (${response.status})`);
  return response.json();
}

export function useSessionRecord(sessionId: string | null) {
  return useSWR(
    sessionId ? `/api/agent-workspaces/${encodeURIComponent(sessionId)}` : null,
    sessionFetcher,
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}
