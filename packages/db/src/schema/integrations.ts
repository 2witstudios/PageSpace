import { pgTable, text, timestamp, boolean, jsonb, index, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/**
 * User Integration Configurations
 *
 * Stores per-user configuration for third-party integrations (e.g., Apify, etc.)
 * Each integration can have:
 * - Encrypted API credentials
 * - Custom configuration settings
 * - Enabled/disabled state
 * - Available tools exposed to AI
 */
export const userIntegrations = pgTable('user_integrations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Integration identifier (e.g., 'apify', 'zapier', 'slack')
  integrationId: text('integrationId').notNull(),

  // Display name for this integration instance (user can customize)
  name: text('name'),

  // Enabled state - allows users to temporarily disable without removing config
  enabled: boolean('enabled').default(true).notNull(),

  // Encrypted API key/token for authentication
  encryptedApiKey: text('encryptedApiKey'),

  // Additional configuration specific to the integration (e.g., base URLs, options)
  config: jsonb('config').$type<Record<string, unknown>>(),

  // Which tools from this integration are enabled for AI use
  // Stores array of tool IDs, null means all tools enabled
  enabledTools: jsonb('enabledTools').$type<string[] | null>(),

  // Last time the integration was successfully validated/tested
  lastValidatedAt: timestamp('lastValidatedAt', { mode: 'date' }),

  // Validation status from last check
  validationStatus: text('validationStatus'), // 'valid' | 'invalid' | 'unknown'
  validationMessage: text('validationMessage'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    // Each user can only have one instance of each integration
    userIntegrationUnique: unique('user_integration_unique').on(table.userId, table.integrationId),
    userIdx: index('user_integrations_user_id_idx').on(table.userId),
    integrationIdx: index('user_integrations_integration_id_idx').on(table.integrationId),
    enabledIdx: index('user_integrations_enabled_idx').on(table.userId, table.enabled),
  };
});

export const userIntegrationsRelations = relations(userIntegrations, ({ one }) => ({
  user: one(users, {
    fields: [userIntegrations.userId],
    references: [users.id],
  }),
}));

// Type exports for use in application code
export type UserIntegration = typeof userIntegrations.$inferSelect;
export type NewUserIntegration = typeof userIntegrations.$inferInsert;
