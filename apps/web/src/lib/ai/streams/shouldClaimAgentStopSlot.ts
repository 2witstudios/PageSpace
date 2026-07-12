/**
 * Single-writer guard for the dashboard store's agent stop-streaming slot:
 * only claim if the slot is currently empty. Lets the dashboard view and the
 * sidebar agent-mode tab co-mount on the same agent without overwriting each
 * other's stop function — first writer wins, second is a no-op.
 */
export const shouldClaimAgentStopSlot = (
  // THIS AGENT's current stop, already looked up by key. The store is keyed by agent now, so
  // "is the slot free" is a question about one agent and cannot be answered on behalf of
  // another — which is exactly what used to cross-wire the dashboard and the sidebar.
  //
  // The union return type is deliberate: `(() => void)` would let TypeScript's void-return
  // rule accept a function returning ANYTHING, which is how an updater-shaped value slipped
  // into a plain value setter and shipped a Stop button that did nothing.
  currentStop: (() => void | Promise<void>) | null,
): boolean => currentStop === null;
