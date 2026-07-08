/**
 * Exposure gating for the interactive ask_user tool.
 *
 * Admin-only rollout: the platform-level app admin role (users.role), NOT a
 * drive membership role. Widen here when the feature graduates.
 */
export function canUseAskUser(
  user: { role?: string | null } | null | undefined
): boolean {
  return user?.role === 'admin';
}
