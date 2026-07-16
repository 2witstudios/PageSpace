/**
 * The `enabled` gate for useAppStateRecovery on the AI chat surfaces.
 *
 * Deliberately takes NO streaming argument, and that is the whole point of it existing.
 *
 * The gate used to be a render-time boolean that folded in `!isStreaming`. iOS freezes JS the
 * moment the app backgrounds, so the value that ended up gating the resume was whatever was true
 * when the app went AWAY — i.e. streaming — and recovery was therefore disabled in exactly the
 * case it was written for. Pass this as a callback (`enabled: () => canResumeRecovery(...)`) so it
 * is evaluated at fire time, and keep streaming out of it: whether the transport is still alive is
 * resolveResumeAction's question, asked on resume, not a flag captured before the freeze.
 *
 * Editing is the only thing that may suppress a resume — recovering underneath a user who is
 * mid-edit would clobber their work.
 */
export const canResumeRecovery = (
  currentConversationId: string | null,
  isAnyEditing: boolean,
): boolean => currentConversationId !== null && !isAnyEditing;
