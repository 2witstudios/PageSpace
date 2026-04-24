/**
 * Vitest setup file - runs before all tests
 * Sets required environment variables for testing
 */
import { vi } from 'vitest';

// Encryption environment variables
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-chars-minimum-required-length'

// CSRF protection environment variables
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret-minimum-32-characters-long-for-testing-purposes'

// Real-time broadcast authentication
process.env.REALTIME_BROADCAST_SECRET = process.env.REALTIME_BROADCAST_SECRET || 'test-realtime-broadcast-secret-32-chars-minimum-length'

// Database connection (for integration tests)
// Note: Integration tests require a running PostgreSQL instance
// See .env.test.example for setup instructions
if (!process.env.DATABASE_URL) {
  // Default to test database if not specified
  process.env.DATABASE_URL = 'postgresql://localhost:5432/pagespace_test'
}

// File storage paths for file processor tests
process.env.FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH || '/tmp/pagespace-test-files'
process.env.PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://localhost:3003'

// Realtime service URL
process.env.INTERNAL_REALTIME_URL = process.env.INTERNAL_REALTIME_URL || 'http://localhost:3001'

// ---------------------------------------------------------------------------
// @pagespace/db subpath forwarding mocks
//
// Source files import from precise subpaths (@pagespace/db/db, /operators,
// /schema/*) but unit tests mock the barrel (@pagespace/db). These lazy
// factory functions forward each subpath mock to the barrel, so a test's
// vi.mock('@pagespace/db', factory) automatically intercepts all subpath
// imports made by the code under test.
//
// Each factory is lazy — it runs when the subpath is first imported, at
// which point the test file's barrel mock is already registered.
// ---------------------------------------------------------------------------

// For each subpath: spread the real module first (all drizzle exports), then
// overlay the barrel mock on top (test spies replace real functions where defined).
// Using importOriginal ensures real drizzle functions serve as fallback for
// anything not defined in the barrel mock.

vi.mock('@pagespace/db/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/db')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});

vi.mock('@pagespace/db/operators', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/operators')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});

vi.mock('@pagespace/db/schema/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/ai')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/auth')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/auth-handoff-tokens', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/auth-handoff-tokens')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/calendar', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/calendar')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/calendar-triggers', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/calendar-triggers')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/chat', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/chat')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/contact', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/contact')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/conversations', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/conversations')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/core')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/dashboard', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/dashboard')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/display-preferences', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/display-preferences')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/email-notifications', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/email-notifications')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/feedback', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/feedback')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/hotkeys', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/hotkeys')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/integrations', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/integrations')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/members', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/members')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/monitoring', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/monitoring')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/notifications', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/notifications')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/page-views', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/page-views')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/permissions', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/permissions')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/personalization', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/personalization')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/push-notifications', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/push-notifications')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/rate-limit-buckets', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/rate-limit-buckets')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/revoked-service-tokens', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/revoked-service-tokens')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/security-audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/security-audit')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/sessions', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/sessions')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/social', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/social')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/storage')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/subscriptions', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/subscriptions')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/tasks', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/tasks')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/versioning', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/versioning')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
vi.mock('@pagespace/db/schema/workflows', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/db/schema/workflows')>();
  const barrel = await import('@pagespace/db') as Record<string, unknown>;
  return { ...real, ...barrel };
});
