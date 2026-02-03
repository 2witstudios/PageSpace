import { pgTable, text, timestamp, jsonb, boolean, index, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

// --- User Dashboard Layout ---
export const userDashboards = pgTable('user_dashboards', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').default('').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
});

export const userDashboardsRelations = relations(userDashboards, ({ one }) => ({
  user: one(users, {
    fields: [userDashboards.userId],
    references: [users.id],
  }),
}));

// --- Pulse Summary Types ---
export const pulseSummaryTypeEnum = pgEnum('pulse_summary_type', [
  'scheduled',   // Auto-generated every 2 hours
  'on_demand',   // User-requested refresh
  'welcome',     // First-time or returning user welcome
]);

// --- Pulse Summaries ---
// AI-generated workspace activity summaries for the dashboard
export const pulseSummaries = pgTable('pulse_summaries', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Summary content
  summary: text('summary').notNull(), // The AI-generated human-readable summary
  greeting: text('greeting'), // Optional personalized greeting (e.g., "Good morning!", "Welcome back!")

  // Summary type and context
  type: pulseSummaryTypeEnum('type').default('scheduled').notNull(),

  // Context data used to generate the summary (for debugging/transparency)
  contextData: jsonb('contextData').$type<{
    // Workspace context - drives and projects
    workspace?: {
      drives: { name: string; description?: string }[];
    };
    // What people are actively working on (most valuable context)
    workingOn?: { person: string; page: string; driveName?: string; action: string }[];
    tasks: {
      dueToday: number;
      dueThisWeek: number;
      overdue: number;
      completedThisWeek: number;
      recentlyCompleted: string[]; // Task titles
      upcoming: string[]; // Task titles
      overdueItems: { title: string; priority: string | null }[]; // Overdue task details
    };
    messages: {
      unreadCount: number;
      recentSenders: string[]; // Display names (legacy)
      recentMessages: { from: string; preview?: string }[]; // Messages with previews
    };
    mentions: { by: string; inPage: string }[]; // @mentions of the user
    notifications: { type: string; from?: string | null; page?: string | null }[]; // Unread notifications
    sharedWithYou: { page: string; by: string }[]; // Recently shared pages
    contentChanges: {
      page: string;
      by: string;
      summary?: string; // Brief description of changes
    }[]; // Recent content updates by others
    pages: {
      updatedToday: number;
      updatedThisWeek: number;
      recentlyUpdated: { title: string; updatedBy: string }[];
    };
    activity: {
      collaboratorNames: string[]; // Who's been active
      recentOperations: string[]; // Brief descriptions
    };
    chatHighlights?: string[]; // Relevant chat snippets
  }>(),

  // AI generation metadata
  aiProvider: text('aiProvider'),
  aiModel: text('aiModel'),

  // Timestamps
  periodStart: timestamp('periodStart', { mode: 'date' }).notNull(), // Start of the period covered
  periodEnd: timestamp('periodEnd', { mode: 'date' }).notNull(), // End of the period covered
  generatedAt: timestamp('generatedAt', { mode: 'date' }).defaultNow().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(), // When this summary is no longer relevant
}, (table) => ({
  userIdIdx: index('idx_pulse_summaries_user_id').on(table.userId),
  generatedAtIdx: index('idx_pulse_summaries_generated_at').on(table.generatedAt),
  expiresAtIdx: index('idx_pulse_summaries_expires_at').on(table.expiresAt),
  userGeneratedIdx: index('idx_pulse_summaries_user_generated').on(table.userId, table.generatedAt),
}));

export const pulseSummariesRelations = relations(pulseSummaries, ({ one }) => ({
  user: one(users, {
    fields: [pulseSummaries.userId],
    references: [users.id],
  }),
}));

// Type exports for use in application code
export type PulseSummary = typeof pulseSummaries.$inferSelect;
export type NewPulseSummary = typeof pulseSummaries.$inferInsert;
export type PulseSummaryContextData = NonNullable<PulseSummary['contextData']>;
