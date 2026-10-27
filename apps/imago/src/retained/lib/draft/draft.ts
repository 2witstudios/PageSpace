export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const buildDraftKey = (
  source: 'channel' | 'dm' | 'ai',
  contextId: string,
  parentId?: string,
): string =>
  parentId
    ? `thread:${source}:${contextId}:${parentId}`
    : source === 'ai'
    ? `ai:${contextId}`
    : `compose:${source}:${contextId}`;

// Server wins only when local is empty — avoids overwriting in-progress typing
// on the same device while still restoring cross-device drafts.
export const mergeDrafts = (local: string, server: string): string =>
  local.trim() ? local : server;

export const shouldPersist = (content: string): boolean =>
  content.trim().length > 0;

export const draftExpiresAt = (now: number): Date =>
  new Date(now + DRAFT_TTL_MS);
