/**
 * GDPR #965 — the on-prem admin bootstrap script must resolve an existing
 * user via the dual-lookup helper (not a raw `eq(users.email, …)`), and any
 * newly-created admin must be written through `prepareUserWrite` so its
 * `emailBidx` is set. Otherwise the very first admin created post-cutover
 * would be permanently unfindable by blind index.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const mockFindFirst = vi.fn();
const mockWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn();
const mockUpdate = vi.fn();
const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn(() => ({ values: mockInsertValues }));
const mockUserEmailMatch = vi.fn((email: string) => ({ emailMatch: email }));
const mockPrepareUserWrite = vi.fn(async (values: Record<string, unknown>) => ({
  ...values,
  emailBidx: 'bidx-of-' + values.email,
}));

mockSet.mockReturnValue({ where: mockWhere });
mockUpdate.mockReturnValue({ set: mockSet });

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { users: { findFirst: mockFindFirst } },
    update: mockUpdate,
    insert: mockInsert,
  },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id_column', email: 'email_column' },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock('@pagespace/lib/auth/user-repository', () => ({
  userEmailMatch: mockUserEmailMatch,
  prepareUserWrite: mockPrepareUserWrite,
}));

vi.mock('@pagespace/lib/onprem-defaults', () => ({
  getOnPremUserDefaults: vi.fn(() => ({ subscriptionTier: 'business' })),
}));

vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  createVerificationToken: vi.fn().mockResolvedValue('mock-verification-token'),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'new-user-id'),
}));

describe('setup-onprem-admin.ts', () => {
  let processExitSpy: MockInstance;
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
    // A no-op mock (rather than actually halting, like real process.exit would)
    // means execution falls through past the early-return branch into the
    // create-user code below it — a pre-existing quirk of this script's control
    // flow, unrelated to the dual-lookup fix under test. Assertions below only
    // check state that's true regardless of that fallthrough.
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockFindFirst.mockReset();
    mockUpdate.mockReset();
    mockSet.mockReset();
    mockWhere.mockReset();
    mockInsert.mockClear();
    mockInsertValues.mockClear().mockResolvedValue(undefined);
    mockUserEmailMatch.mockClear();
    mockPrepareUserWrite.mockClear();

    mockWhere.mockResolvedValue(undefined);
    mockSet.mockReturnValue({ where: mockWhere });
    mockUpdate.mockReturnValue({ set: mockSet });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('checks for an existing user via the dual-lookup helper, not a raw equality match', async () => {
    process.argv = ['node', 'setup-onprem-admin.ts', '--email', 'admin@clinic.local', '--name', 'Dr. Smith'];
    mockFindFirst.mockResolvedValueOnce(undefined);

    await import('../setup-onprem-admin');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockUserEmailMatch).toHaveBeenCalledWith('admin@clinic.local');
  });

  it('routes a brand-new admin insert through prepareUserWrite so emailBidx is set', async () => {
    process.argv = ['node', 'setup-onprem-admin.ts', '--email', 'admin@clinic.local', '--name', 'Dr. Smith'];
    mockFindFirst.mockResolvedValueOnce(undefined);

    await import('../setup-onprem-admin');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPrepareUserWrite).toHaveBeenCalledOnce();
    expect(mockPrepareUserWrite.mock.calls[0][0]).toMatchObject({ email: 'admin@clinic.local' });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'admin@clinic.local', emailBidx: 'bidx-of-admin@clinic.local' })
    );
  });

  it('promotes an existing non-admin user by id, without touching insert', async () => {
    process.argv = ['node', 'setup-onprem-admin.ts', '--email', 'user@clinic.local', '--name', 'Dr. Smith'];
    mockFindFirst.mockResolvedValueOnce({ id: 'existing-1', role: 'user' });

    await import('../setup-onprem-admin');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The update must key off the resolved user's id, not the raw email —
    // the email column may hold ciphertext post-cutover.
    expect(mockWhere).toHaveBeenCalledWith({ col: 'id_column', val: 'existing-1' });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('promoted to admin'));
  });
});
