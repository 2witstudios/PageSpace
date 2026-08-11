/**
 * resolveRequestTimezone — the route-handler equivalent of the AI tool path's
 * ToolExecutionContext.timezone lookup.
 *
 * REST callers (the SDK, and therefore every MCP tool the CLI serves) rarely
 * send a timezone. Routes that defaulted straight to 'UTC' reinterpreted every
 * naive wall-clock time those callers sent, which is why calendar writes landed
 * offset from the user's actual day while the in-app chat path — which loads
 * the profile timezone into tool context — looked fine.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const selectWhere = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { userPersonalization: { findFirst: vi.fn() } },
    select: () => ({ from: () => ({ where: (...a: unknown[]) => selectWhere(...a) }) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', timezone: 'timezone' } }));
vi.mock('@pagespace/db/schema/personalization', () => ({ userPersonalization: { userId: 'userId' } }));
vi.mock('@pagespace/lib/memory/memory-pages', () => ({ readMemoryPages: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { resolveRequestTimezone } from '../personalization-utils';

const withProfileTimezone = (timezone: string | null) =>
  selectWhere.mockResolvedValue([{ timezone }]);

describe('resolveRequestTimezone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withProfileTimezone('America/Chicago');
  });

  it('prefers an explicit timezone from the caller', async () => {
    expect(await resolveRequestTimezone('Europe/Berlin', 'user-1')).toBe('Europe/Berlin');
  });

  it('falls back to the caller profile timezone when none is supplied', async () => {
    expect(await resolveRequestTimezone(undefined, 'user-1')).toBe('America/Chicago');
  });

  it('treats a blank explicit timezone as absent', async () => {
    expect(await resolveRequestTimezone('   ', 'user-1')).toBe('America/Chicago');
  });

  it('falls through to the profile when the explicit value is not a real IANA zone', async () => {
    expect(await resolveRequestTimezone('Not/AZone', 'user-1')).toBe('America/Chicago');
  });

  it('ignores non-string explicit values', async () => {
    expect(await resolveRequestTimezone(300, 'user-1')).toBe('America/Chicago');
  });

  it('lands on UTC when the profile has no timezone either', async () => {
    withProfileTimezone(null);
    expect(await resolveRequestTimezone(undefined, 'user-1')).toBe('UTC');
  });

  it('lands on UTC when the profile lookup finds no user', async () => {
    selectWhere.mockResolvedValue([]);
    expect(await resolveRequestTimezone(undefined, 'user-1')).toBe('UTC');
  });
});
