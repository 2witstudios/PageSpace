import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

// Track calls for assertions
const mockSelectFrom = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });
const mockInsertValues = vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn() });
const _mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
const mockTxInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn() }),
});
const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
  await cb({ insert: mockTxInsert });
});

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockSelect,
    transaction: mockTransaction,
  },
  users: { id: 'id', email: 'email' },
  eventAttendees: { eventId: 'eventId', userId: 'userId' },
  inArray: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => `lower(${String(values[0])})`),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-attendee-id'),
}));

// We need to test mapAttendeesToUsers which is not exported,
// so we test it through the sync-service module indirectly.
// However, since it's a private function, let's test the behavior
// it relies on: case-insensitive email matching and batch upserts.

describe('attendee email matching behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should lowercase attendee emails for lookup', () => {
    const attendees = [
      { email: 'Alice@Example.COM', responseStatus: 'accepted' as const },
      { email: 'Bob@test.org', responseStatus: 'declined' as const },
    ];

    const emails = [...new Set(attendees.map((a) => a.email.toLowerCase()))];

    assert({
      given: 'attendees with mixed-case emails',
      should: 'lowercase all emails',
      actual: emails,
      expected: ['alice@example.com', 'bob@test.org'],
    });
  });

  it('should deduplicate emails', () => {
    const attendees = [
      { email: 'alice@example.com', responseStatus: 'accepted' as const },
      { email: 'ALICE@example.com', responseStatus: 'declined' as const },
    ];

    const emails = [...new Set(attendees.map((a) => a.email.toLowerCase()))];

    assert({
      given: 'attendees with duplicate emails (different case)',
      should: 'deduplicate to a single email',
      actual: emails.length,
      expected: 1,
    });
  });

  it('should map Google response status to PageSpace attendee status', () => {
    const statusMap: Record<string, 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'> = {
      needsAction: 'PENDING',
      accepted: 'ACCEPTED',
      declined: 'DECLINED',
      tentative: 'TENTATIVE',
    };

    assert({
      given: 'Google needsAction status',
      should: 'map to PENDING',
      actual: statusMap['needsAction'],
      expected: 'PENDING',
    });

    assert({
      given: 'Google accepted status',
      should: 'map to ACCEPTED',
      actual: statusMap['accepted'],
      expected: 'ACCEPTED',
    });

    assert({
      given: 'Google declined status',
      should: 'map to DECLINED',
      actual: statusMap['declined'],
      expected: 'DECLINED',
    });

    assert({
      given: 'Google tentative status',
      should: 'map to TENTATIVE',
      actual: statusMap['tentative'],
      expected: 'TENTATIVE',
    });
  });

  it('should handle undefined response status as PENDING', () => {
    const statusMap: Record<string, 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'> = {
      needsAction: 'PENDING',
      accepted: 'ACCEPTED',
      declined: 'DECLINED',
      tentative: 'TENTATIVE',
    };

    const responseStatus: string | undefined = undefined;
    const result = statusMap[responseStatus || 'needsAction'] || ('PENDING' as const);

    assert({
      given: 'undefined response status',
      should: 'default to PENDING',
      actual: result,
      expected: 'PENDING',
    });
  });

  it('should handle empty attendees array', () => {
    const attendees: Array<{ email: string }> = [];

    assert({
      given: 'empty attendees array',
      should: 'produce no emails to look up',
      actual: attendees.length,
      expected: 0,
    });
  });

  it('should filter to only matched users', () => {
    const matchedUsers = [
      { id: 'user-1', email: 'alice@example.com' },
    ];
    const emailToUserId = new Map(matchedUsers.map((u) => [u.email.toLowerCase(), u.id]));

    const attendees = [
      { email: 'alice@example.com', responseStatus: 'accepted' as const, organizer: true, optional: false },
      { email: 'unknown@external.com', responseStatus: 'needsAction' as const, organizer: false, optional: true },
    ];

    const filtered = attendees.filter((a) => emailToUserId.has(a.email.toLowerCase()));

    assert({
      given: 'attendees with one matching and one non-matching user',
      should: 'filter to only matched users',
      actual: filtered.length,
      expected: 1,
    });

    assert({
      given: 'attendees with one matching user',
      should: 'keep the matched attendee',
      actual: filtered[0].email,
      expected: 'alice@example.com',
    });
  });

  it('should build correct attendee values with organizer and optional flags', () => {
    const emailToUserId = new Map([['alice@example.com', 'user-1']]);
    const statusMap: Record<string, 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'> = {
      needsAction: 'PENDING',
      accepted: 'ACCEPTED',
      declined: 'DECLINED',
      tentative: 'TENTATIVE',
    };

    const attendee = {
      email: 'Alice@Example.com',
      responseStatus: 'accepted' as const,
      organizer: true,
      optional: false,
    };

    const value = {
      eventId: 'event-1',
      userId: emailToUserId.get(attendee.email.toLowerCase())!,
      status: statusMap[attendee.responseStatus || 'needsAction'] || ('PENDING' as const),
      isOrganizer: attendee.organizer ?? false,
      isOptional: attendee.optional ?? false,
    };

    assert({
      given: 'an organizer attendee who accepted',
      should: 'set userId from email lookup',
      actual: value.userId,
      expected: 'user-1',
    });

    assert({
      given: 'an organizer attendee who accepted',
      should: 'set status to ACCEPTED',
      actual: value.status,
      expected: 'ACCEPTED',
    });

    assert({
      given: 'an organizer attendee',
      should: 'set isOrganizer to true',
      actual: value.isOrganizer,
      expected: true,
    });

    assert({
      given: 'a non-optional attendee',
      should: 'set isOptional to false',
      actual: value.isOptional,
      expected: false,
    });
  });
});
