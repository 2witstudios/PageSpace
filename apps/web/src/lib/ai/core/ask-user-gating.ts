/**
 * Exposure gating for the interactive ask_user tool.
 *
 * Available to every authenticated user (graduated from the original
 * admin-only rollout). No user in context still means no access.
 */
export function canUseAskUser(
  user: { role?: string | null } | null | undefined
): boolean {
  return user != null;
}
