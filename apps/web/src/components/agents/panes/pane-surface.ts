/**
 * Which surface a pane renders — a pure decision, colocated-tested, so the
 * render branch in the grid stays a lookup rather than a policy.
 *
 * **The model deleted one of its inputs.** The previous version read a
 * `PaneScope`, in which "bound to a kind, not yet to a row" was spellable
 * (`targetId: null`) — the state a pane sat in while its conversation or shell
 * was being minted. A `PaneTarget` is one object precisely so a half-bound pane
 * cannot be spelled, so that state is now what it always was in truth: a fact
 * about a REQUEST IN FLIGHT IN THIS BROWSER, not about the durable tree. It is
 * passed in as `isMinting` and lives in the component that owns the request.
 *
 * The rule it protected survives intact and is the reason this still has a
 * `loading` case at all:
 *
 *   > the unanswered state means `loading`, never a mounted Xterm: opening a PTY
 *   > stream registers this pane as a viewer server-side, so guessing "pty" for
 *   > what turns out to be a chat isn't a harmless flash, it's a connection.
 */

import type { PaneNode } from '@pagespace/lib/agent-workspaces/workspace-node';

export type PaneSurface =
  /** Unbound — the pane shows the picker. */
  | { surface: 'picker' }
  /** Unbound, with a mint in flight from this browser. Hold. */
  | { surface: 'loading' }
  | { surface: 'terminal'; shellId: string }
  | { surface: 'chat'; conversationId: string }
  | { surface: 'page'; pageId: string };

export function resolvePaneSurface(node: PaneNode, isMinting: boolean): PaneSurface {
  if (node.target === null) {
    // The picker has chosen and the mint is in flight. Holding here is what
    // keeps a chat pane from flashing a terminal — and, more importantly, from
    // opening a PTY stream it would have to close.
    return isMinting ? { surface: 'loading' } : { surface: 'picker' };
  }

  if (node.target.kind === 'chat') return { surface: 'chat', conversationId: node.target.id };
  if (node.target.kind === 'terminal') return { surface: 'terminal', shellId: node.target.id };
  // A page binding addresses an existing page directly — there is no mint to
  // wait on, so this is reachable the very first render after the bind.
  if (node.target.kind === 'page') return { surface: 'page', pageId: node.target.id };

  // A `kind` this module has never heard of — a row that predates a schema
  // change, or a payload slipping past the wire schema — must never fall through
  // to a live PTY. Treating "not chat" as "therefore terminal" is exactly
  // backwards for an unknown value.
  return { surface: 'loading' };
}
