export type ResumeAction = 'rejoin-and-refresh' | 'refresh' | 'noop';

export function resolveResumeAction({
  native,
  isStreaming,
}: {
  native: boolean;
  isStreaming: boolean;
}): ResumeAction {
  if (isStreaming) return native ? 'rejoin-and-refresh' : 'noop';
  return 'refresh';
}
