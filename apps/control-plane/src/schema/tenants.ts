import { pgTable, text, varchar, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'

export const tenantStatusEnum = pgEnum('tenant_status', [
  'provisioning',
  'active',
  'suspended',
  'destroying',
  'destroyed',
  'failed',
])

export const healthStatusEnum = pgEnum('health_status', [
  'healthy',
  'unhealthy',
  'unknown',
])

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  status: tenantStatusEnum('status').notNull().default('provisioning'),
  tier: varchar('tier', { length: 50 }).notNull(),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
  ownerEmail: varchar('owner_email', { length: 255 }).notNull(),
  infraId: varchar('infra_id', { length: 255 }),
  provider: varchar('provider', { length: 50 }).notNull().default('docker'),
  encryptedSecrets: jsonb('encrypted_secrets'),
  resourceLimits: jsonb('resource_limits'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
  lastHealthCheck: timestamp('last_health_check', { withTimezone: true }),
  healthStatus: healthStatusEnum('health_status').notNull().default('unknown'),
})
