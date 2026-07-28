/**
 * The leaves of a session view, as ordered descriptors.
 *
 * v1 renders these as tabs. A later version renders the same descriptors as
 * resizable panes. Neither container gets to decide what the leaves ARE — that
 * decision lives here, which is what makes "swap the tab container for a pane
 * container later" a structural fact rather than a hope. The old surface's
 * `pane-surface.ts`/`workspace-reducer` are deliberately not carried forward;
 * this module is the whole of what replaces them at this seam.
 */

import type { ShellDTO } from '@pagespace/lib/agent-sessions/contract';

/** The chat leaf's id. Reserved — no shell tab can take it (see `shellTabId`). */
export const CHAT_TAB_ID = 'chat';

interface ChatTabDescriptor {
  id: typeof CHAT_TAB_ID;
  kind: 'chat';
  label: string;
  /** Present as `undefined` so callers can read `.shellId` off the union directly. */
  shellId?: undefined;
}

interface ShellTabDescriptor {
  id: string;
  kind: 'shell';
  label: string;
  /** The wire address. Everything the leaf does — connect, resize, kill — uses this. */
  shellId: string;
}

export type SessionTabDescriptor = ChatTabDescriptor | ShellTabDescriptor;

/**
 * A shell's tab id is namespaced rather than the bare shellId. The container
 * keys on `id`, and a bare id would put shells in the same namespace as the
 * reserved chat tab — cuid2 will never mint `"chat"`, but a container whose keys
 * *can* collide is a container that will, eventually, unmount the wrong pane.
 */
const shellTabId = (shellId: string): string => `shell:${shellId}`;

/** Unparseable timestamps sort last rather than poisoning the comparison with NaN. */
function createdAtOrder(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Chat first, then every shell oldest-first.
 *
 * Chat is not derived from anything: the conversation IS the session, so there
 * is no state in which a session lacks a chat surface — including the very
 * common one where the shells list hasn't loaded (or 404'd because no sandbox
 * was ever provisioned).
 *
 * The shell order is TOTAL — `createdAt`, then `shellId` — because a partial
 * order would let two shells opened in the same millisecond swap places between
 * renders, reshuffling live PTYs. Duplicate shellIds keep the first occurrence,
 * which is what makes an optimistic add landing beside its own server echo
 * render one pane instead of two.
 */
export function resolveSessionTabs(shells: readonly ShellDTO[] | undefined): SessionTabDescriptor[] {
  const chatTab: ChatTabDescriptor = { id: CHAT_TAB_ID, kind: 'chat', label: 'Chat' };
  if (!shells || shells.length === 0) return [chatTab];

  const seen = new Set<string>();
  const ordered = shells
    .filter((shell) => {
      if (!shell.shellId || seen.has(shell.shellId)) return false;
      seen.add(shell.shellId);
      return true;
    })
    .slice()
    .sort((a, b) => {
      const byCreatedAt = createdAtOrder(a.createdAt) - createdAtOrder(b.createdAt);
      if (byCreatedAt !== 0) return byCreatedAt;
      return a.shellId < b.shellId ? -1 : a.shellId > b.shellId ? 1 : 0;
    })
    .map<ShellTabDescriptor>((shell) => ({
      id: shellTabId(shell.shellId),
      kind: 'shell',
      // A tab with an empty title is unclickable in practice. The id is never
      // pretty, but it is always there.
      label: shell.name || shell.shellId,
      shellId: shell.shellId,
    }));

  return [chatTab, ...ordered];
}
