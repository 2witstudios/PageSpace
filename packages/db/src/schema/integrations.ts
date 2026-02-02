/**
 * AI API Sandbox - Database Schema
 *
 * Tables for external API integrations with zero-trust security model.
 * Supports both user-scoped and drive-scoped integrations.
 */

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  pgEnum,
  index,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives, pages } from './core';

// ═══════════════════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════════════════

export const integrationProviderTypeEnum = pgEnum('integration_provider_type', [
  'builtin',
  'openapi',
  'custom',
  'mcp',
  'webhook',
]);

export const integrationConnectionStatusEnum = pgEnum('integration_connection_status', [
  'active',
  'expired',
  'error',
  'pending',
  'revoked',
]);

export const integrationVisibilityEnum = pgEnum('integration_visibility', [
  'private',
  'owned_drives',
  'all_drives',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION PROVIDERS
// Defines available integration types (system-level or custom)
// ═══════════════════════════════════════════════════════════════════════════════

export const integrationProviders = pgTable(
  'integration_providers',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    iconUrl: text('icon_url'),
    documentationUrl: text('documentation_url'),

    providerType: integrationProviderTypeEnum('provider_type').notNull(),

    // Full provider configuration as JSON (IntegrationProviderConfig type)
    config: jsonb('config').notNull(),

    // For OpenAPI imports - the original spec
    openApiSpec: text('openapi_spec'),

    // Ownership
    isSystem: boolean('is_system').default(false).notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    driveId: text('drive_id').references(() => drives.id, { onDelete: 'cascade' }),

    // Status
    enabled: boolean('enabled').default(true).notNull(),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    slugIdx: index('integration_providers_slug_idx').on(table.slug),
    driveIdx: index('integration_providers_drive_id_idx').on(table.driveId),
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION CONNECTIONS
// Authenticated connections to providers (user or drive owned)
// ═══════════════════════════════════════════════════════════════════════════════

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    providerId: text('provider_id')
      .notNull()
      .references(() => integrationProviders.id, { onDelete: 'cascade' }),

    // EITHER user OR drive (determines scope)
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    driveId: text('drive_id').references(() => drives.id, { onDelete: 'cascade' }),

    // Connection name (for multiple connections to same provider)
    name: text('name').notNull(),

    // Status
    status: integrationConnectionStatusEnum('status').notNull().default('pending'),
    statusMessage: text('status_message'),

    // Encrypted credentials (structure depends on provider's authMethod)
    // All values should be encrypted before storage
    credentials: jsonb('credentials'),

    // Override base URL (for self-hosted instances)
    baseUrlOverride: text('base_url_override'),

    // Connection-level config overrides
    configOverrides: jsonb('config_overrides'),

    // Account metadata (safe to display)
    accountMetadata: jsonb('account_metadata'),

    // Visibility (for user connections only)
    visibility: integrationVisibilityEnum('visibility').default('owned_drives'),

    // OAuth state for CSRF protection during auth flow
    oauthState: text('oauth_state'),

    // Who connected
    connectedBy: text('connected_by').references(() => users.id, { onDelete: 'set null' }),
    connectedAt: timestamp('connected_at', { mode: 'date' }),

    // Usage tracking
    lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
    lastHealthCheck: timestamp('last_health_check', { mode: 'date' }),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    providerIdx: index('integration_connections_provider_id_idx').on(table.providerId),
    userIdx: index('integration_connections_user_id_idx').on(table.userId),
    driveIdx: index('integration_connections_drive_id_idx').on(table.driveId),
    userProviderUnique: unique('integration_connections_user_provider').on(
      table.userId,
      table.providerId
    ),
    driveProviderUnique: unique('integration_connections_drive_provider').on(
      table.driveId,
      table.providerId
    ),
    userOrDriveScope: check(
      'integration_connections_scope_chk',
      sql`(${table.userId} IS NOT NULL AND ${table.driveId} IS NULL) OR (${table.userId} IS NULL AND ${table.driveId} IS NOT NULL)`
    ),
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TOOL GRANTS
// Which tools from a connection an agent can use
// ═══════════════════════════════════════════════════════════════════════════════

export const integrationToolGrants = pgTable(
  'integration_tool_grants',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),

    // The agent receiving the grant
    agentId: text('agent_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),

    // The connection being granted
    connectionId: text('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),

    // Tool permissions (null = all tools from provider)
    allowedTools: jsonb('allowed_tools'),
    deniedTools: jsonb('denied_tools'),

    // Force read-only mode
    readOnly: boolean('read_only').default(false).notNull(),

    // Rate limit override for this grant
    rateLimitOverride: jsonb('rate_limit_override'),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index('integration_tool_grants_agent_id_idx').on(table.agentId),
    connectionIdx: index('integration_tool_grants_connection_id_idx').on(table.connectionId),
    agentConnectionUnique: unique('integration_tool_grants_agent_connection').on(
      table.agentId,
      table.connectionId
    ),
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL ASSISTANT CONFIG
// Per-user preferences for their global assistant
// ═══════════════════════════════════════════════════════════════════════════════

export const globalAssistantConfig = pgTable('global_assistant_config', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Which user integrations the global assistant can use (null = all)
  enabledUserIntegrations: jsonb('enabled_user_integrations'),

  // Per-drive overrides for the global assistant
  driveOverrides: jsonb('drive_overrides'),

  // Whether to include drive integrations by default
  inheritDriveIntegrations: boolean('inherit_drive_integrations').default(true).notNull(),

  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION AUDIT LOG
// Every external API call is logged
// ═══════════════════════════════════════════════════════════════════════════════

export const integrationAuditLog = pgTable(
  'integration_audit_log',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),

    // Context
    driveId: text('drive_id')
      .notNull()
      .references(() => drives.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => pages.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),

    // Operation details
    toolName: text('tool_name').notNull(),
    inputSummary: text('input_summary'),

    // Results
    success: boolean('success').notNull(),
    responseCode: integer('response_code'),
    errorType: text('error_type'),
    errorMessage: text('error_message'),

    // Performance
    durationMs: integer('duration_ms'),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    driveIdx: index('integration_audit_log_drive_id_idx').on(table.driveId),
    connectionIdx: index('integration_audit_log_connection_id_idx').on(table.connectionId),
    createdAtIdx: index('integration_audit_log_created_at_idx').on(table.createdAt),
    driveCreatedAtIdx: index('integration_audit_log_drive_created_at_idx').on(
      table.driveId,
      table.createdAt
    ),
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// RELATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const integrationProvidersRelations = relations(integrationProviders, ({ one, many }) => ({
  createdByUser: one(users, {
    fields: [integrationProviders.createdBy],
    references: [users.id],
  }),
  drive: one(drives, {
    fields: [integrationProviders.driveId],
    references: [drives.id],
  }),
  connections: many(integrationConnections),
}));

export const integrationConnectionsRelations = relations(
  integrationConnections,
  ({ one, many }) => ({
    provider: one(integrationProviders, {
      fields: [integrationConnections.providerId],
      references: [integrationProviders.id],
    }),
    user: one(users, {
      fields: [integrationConnections.userId],
      references: [users.id],
    }),
    drive: one(drives, {
      fields: [integrationConnections.driveId],
      references: [drives.id],
    }),
    connectedByUser: one(users, {
      fields: [integrationConnections.connectedBy],
      references: [users.id],
      relationName: 'connectedBy',
    }),
    toolGrants: many(integrationToolGrants),
    auditLogs: many(integrationAuditLog),
  })
);

export const integrationToolGrantsRelations = relations(integrationToolGrants, ({ one }) => ({
  agent: one(pages, {
    fields: [integrationToolGrants.agentId],
    references: [pages.id],
  }),
  connection: one(integrationConnections, {
    fields: [integrationToolGrants.connectionId],
    references: [integrationConnections.id],
  }),
}));

export const globalAssistantConfigRelations = relations(globalAssistantConfig, ({ one }) => ({
  user: one(users, {
    fields: [globalAssistantConfig.userId],
    references: [users.id],
  }),
}));

export const integrationAuditLogRelations = relations(integrationAuditLog, ({ one }) => ({
  drive: one(drives, {
    fields: [integrationAuditLog.driveId],
    references: [drives.id],
  }),
  agent: one(pages, {
    fields: [integrationAuditLog.agentId],
    references: [pages.id],
  }),
  user: one(users, {
    fields: [integrationAuditLog.userId],
    references: [users.id],
  }),
  connection: one(integrationConnections, {
    fields: [integrationAuditLog.connectionId],
    references: [integrationConnections.id],
  }),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export type IntegrationProvider = typeof integrationProviders.$inferSelect;
export type NewIntegrationProvider = typeof integrationProviders.$inferInsert;

export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection = typeof integrationConnections.$inferInsert;

export type IntegrationToolGrant = typeof integrationToolGrants.$inferSelect;
export type NewIntegrationToolGrant = typeof integrationToolGrants.$inferInsert;

export type GlobalAssistantConfig = typeof globalAssistantConfig.$inferSelect;
export type NewGlobalAssistantConfig = typeof globalAssistantConfig.$inferInsert;

export type IntegrationAuditLogEntry = typeof integrationAuditLog.$inferSelect;
export type NewIntegrationAuditLogEntry = typeof integrationAuditLog.$inferInsert;
