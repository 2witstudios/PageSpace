/**
 * Vitest setup file for apps/processor
 *
 * Forwards @pagespace/db subpath imports to the barrel mock so that test
 * files using vi.mock('@pagespace/db', factory) automatically intercept
 * subpath imports made by the code under test (e.g. security-audit.ts
 * which imports from @pagespace/db/db, /operators, /schema/*).
 */
import { vi } from 'vitest';

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
