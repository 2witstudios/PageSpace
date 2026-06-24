export type ResumeAction = 'rejoin-and-refresh' | 'refresh' | 'noop';

export function resolveResumeAction({
  native,
  isStreaming,
}: {
  native: boolean;
  isStreaming: boolean;
}): ResumeAction {
  // On native (Capacitor) the local fetch is always dead after backgrounding —
  // regardless of whether useChat still reports streaming — so we always rejoin.
  if (native) return 'rejoin-and-refresh';
  // Web + live fetch: don't clobber it; the existing stream is healthy.
  if (isStreaming) return 'noop';
  return 'refresh';
}
