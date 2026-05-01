/**
 * Single-writer guard for the dashboard store's agent stop-streaming slot:
 * only claim if the slot is currently empty. Lets the dashboard view and the
 * sidebar agent-mode tab co-mount on the same agent without overwriting each
 * other's stop function — first writer wins, second is a no-op.
 */
export const shouldClaimAgentStopSlot = (
  currentStop: (() => void) | null,
): boolean => currentStop === null;
