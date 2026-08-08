/**
 * Decides whether a messages pane renders virtualized, deferring any *change*
 * of mode until the stream in flight has settled.
 *
 * Crossing the threshold swaps plain DOM rows for virtualized ones. Every
 * height measured against the plain rows is discarded in that swap, and the
 * virtualizer restarts from `estimateSize` for all of them, so the container's
 * total height collapses and the browser clamps scrollTop upward — the same
 * jump VirtualizedMessageList's removed `measure()` effect used to cause, just
 * one-shot instead of per-part.
 *
 * The crossing lands mid-stream by construction: it is the streaming message
 * itself that pushes the count over. Holding the previous mode until the stream
 * ends moves the one unavoidable re-measure to a moment when the user is not
 * watching content arrive.
 *
 * This defers changes only — `current` is expected to be seeded from the first
 * `desired` value, so a conversation that is already long when it opens
 * virtualizes immediately rather than rendering every message as plain DOM.
 *
 * Pure — no I/O, no side effects.
 */
export interface VirtualizationModeInput {
  /** What the caller's own threshold rule wants right now. */
  desired: boolean;
  /** True while a stream is in flight (own or remote) for this pane. */
  isStreaming: boolean;
  /** The mode currently rendered, held by the caller across renders. */
  current: boolean;
}

export const selectVirtualizationMode = ({
  desired,
  isStreaming,
  current,
}: VirtualizationModeInput): boolean => (isStreaming ? current : desired);
