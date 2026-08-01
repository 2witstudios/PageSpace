/**
 * Which surface a pane renders — a pure decision, colocated-tested, so the
 * render branch in the grid stays a lookup rather than a policy.
 *
 * Ported from the machine grid's `pane-surface.ts` (623e632e7^) and simplified
 * by the model change. The old version had to resolve a kind-less binding by
 * looking the pane's NAME up in a session list, because layouts predating the
 * chat pane stored no kind. Its safety rule for that lookup was:
 *
 *   > the unanswered list means `loading`, never a mounted Xterm: opening a PTY
 *   > stream registers this pane as a viewer server-side, so guessing "pty" for
 *   > what turns out to be a chat isn't a harmless flash, it's a connection.
 *
 * There are no kind-less bindings here — `paneScopeSchema` requires `kind`, and
 * every binding is written by the picker that knew what it was spawning. So the
 * name lookup is gone. The rule it protected is not: a pane whose target has
 * not resolved yet renders `loading`, never a speculative terminal.
 */

import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';

export type PaneSurface =
  /** Unbound — the pane shows the picker. */
  | { surface: 'picker' }
  /** Bound, but the row it addresses does not exist yet. Hold. */
  | { surface: 'loading' }
  | { surface: 'terminal'; shellId: string }
  | { surface: 'chat'; conversationId: string; agentPageId: string | null }
  | { surface: 'page'; pageId: string };

export function resolvePaneSurface(scope: PaneScope | null): PaneSurface {
  if (scope === null) return { surface: 'picker' };

  // Bound to a kind but not yet to a row: the picker has chosen and the mint is
  // in flight. Holding here is what keeps a chat pane from flashing a terminal
  // — and, more importantly, from opening a PTY stream it would have to close.
  if (scope.targetId === null) return { surface: 'loading' };

  if (scope.kind === 'chat') return { surface: 'chat', conversationId: scope.targetId, agentPageId: scope.agentPageId };
  if (scope.kind === 'terminal') return { surface: 'terminal', shellId: scope.targetId };
  // A page binding addresses an existing page directly — there is no mint to
  // wait on, so this is reachable the very first render after assignment.
  if (scope.kind === 'page') return { surface: 'page', pageId: scope.targetId };

  // A `kind` this module has never heard of — a stale persisted value that
  // predates a schema change, or a corrupted store slipping past
  // `paneScopeSchema` — must never fall through to a live PTY. The old
  // `scope.kind === 'chat' ? chat : terminal` ternary treated "not chat" as
  // "therefore terminal," which is exactly backwards for an unknown value.
  return { surface: 'loading' };
}
