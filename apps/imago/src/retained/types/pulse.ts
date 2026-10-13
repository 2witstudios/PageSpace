import type { HomeContext, Signal } from '@pagespace/lib/home-signals/types';

/** Mirrors apps/web's GET /api/pulse response (app/api/pulse/route.ts); keep in sync. */
export type PulseResponse = {
  // AI-generated summary (may be null if no recent summary)
  summary: {
    id: string;
    text: string;
    greeting: string | null;
    generatedAt: Date;
    expiresAt: Date;
    isStale: boolean; // True if older than 6 hours
  } | null;

  // Real-time stats (always fresh)
  stats: {
    tasks: {
      dueToday: number;
      dueThisWeek: number;
      overdue: number;
      completedThisWeek: number;
    };
    messages: {
      unreadCount: number;
    };
    pages: {
      updatedToday: number;
      updatedThisWeek: number;
    };
    calendar: {
      upcomingToday: number;
      pendingInvites: number;
    };
  };

  // Should the client request a new summary?
  shouldRefresh: boolean;

  // Ranked, permission-scoped facts behind the Home "signal line" (see
  // packages/lib/src/home-signals). Additive: existing clients (the sidebar
  // Pulse widget) can ignore this and keep reading `summary`/`stats`.
  signals: Signal[];
  context: HomeContext;
};
