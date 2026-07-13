export const deriveBadgeCount = (unreadCount: number): number => Math.max(0, Math.trunc(unreadCount));
