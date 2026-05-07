/**
 * Contract tests for buildMagicLinkPorts adapter.
 *
 * Coverage focuses on the IO-boundary behaviour the pure pipe relies on:
 * - sendMagicLinkEmail builds the verify URL that lands in the user's inbox
 * - When `next` is supplied, the URL embeds &next=<encoded> so the verify
 *   route can honour it
 * - When `next` is absent, the URL has no next param at all (no empty/null
 *   trailing query)
 * - Token is always URL-encoded
 *
 * The pipe is the source of truth for whether `next` is safe; this layer is
 * a transport — it must not silently transform or drop a value the pipe
 * forwarded.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const { sendEmailMock, dbInsertMock, dbSelectMock, returningMock, selectWhereMock } =
  vi.hoisted(() => {
    const returning = vi.fn();
    const insertValues = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values: insertValues }));
    const where = vi.fn();
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    return {
      sendEmailMock: vi.fn().mockResolvedValue(undefined),
      dbInsertMock: insert,
      dbSelectMock: select,
      returningMock: returning,
      selectWhereMock: where,
    };
  });

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: sendEmailMock,
}));

vi.mock('@pagespace/lib/email-templates/MagicLinkEmail', () => ({
  MagicLinkEmail: () => null,
}));

vi.mock('@pagespace/db/db', () => ({
  db: { insert: dbInsertMock, select: dbSelectMock },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  verificationTokens: {},
  users: { id: 'users.id', email: 'users.email' },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock('@pagespace/lib/auth/token-utils', () => ({
  generateToken: vi.fn(() => ({ token: 'tok_raw', hash: 'tok_hash', tokenPrefix: 'tok_' })),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: { loadUserAccountByEmail: vi.fn() },
}));

import { buildMagicLinkPorts } from '../magic-link-adapters';

describe('buildMagicLinkPorts.sendMagicLinkEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('WEB_APP_URL', 'https://example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('given no next, builds a verify URL with only the encoded token', async () => {
    const ports = buildMagicLinkPorts();
    await ports.sendMagicLinkEmail({ email: 'u@example.com', token: 'abc 123' });

    expect(sendEmailMock).toHaveBeenCalledOnce();
    const args = sendEmailMock.mock.calls[0][0] as {
      to: string;
      subject: string;
      react: { props: { magicLinkUrl: string } };
    };
    const url = args.react.props.magicLinkUrl;
    expect(url).toBe('https://example.com/api/auth/magic-link/verify?token=abc%20123');
  });

  it('given a safe next, appends &next=<encoded> after the token', async () => {
    const ports = buildMagicLinkPorts();
    await ports.sendMagicLinkEmail({
      email: 'u@example.com',
      token: 'tok',
      next: '/dashboard/drive_abc',
    });

    expect(sendEmailMock).toHaveBeenCalledOnce();
    const args = sendEmailMock.mock.calls[0][0] as {
      react: { props: { magicLinkUrl: string } };
    };
    const url = args.react.props.magicLinkUrl;
    expect(url).toBe(
      'https://example.com/api/auth/magic-link/verify?token=tok&next=%2Fdashboard%2Fdrive_abc',
    );
  });

  it('given a next with query/hash, encodes the full path so the verify route can re-validate', async () => {
    const ports = buildMagicLinkPorts();
    await ports.sendMagicLinkEmail({
      email: 'u@example.com',
      token: 'tok',
      next: '/dashboard?welcome=1#top',
    });

    expect(sendEmailMock).toHaveBeenCalledOnce();
    const args = sendEmailMock.mock.calls[0][0] as {
      react: { props: { magicLinkUrl: string } };
    };
    const url = args.react.props.magicLinkUrl;
    expect(url).toContain('token=tok');
    expect(url).toContain('next=%2Fdashboard%3Fwelcome%3D1%23top');
  });
});

describe('buildMagicLinkPorts.createUserAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a fresh email, inserts a users row with tosAcceptedAt and returns the new id', async () => {
    returningMock.mockResolvedValueOnce([{ id: 'user_new_123' }]);
    const tosAcceptedAt = new Date('2026-05-07T22:00:00.000Z');

    const ports = buildMagicLinkPorts();
    const result = await ports.createUserAccount({
      email: 'fresh@example.com',
      tosAcceptedAt,
    });

    expect(result).toEqual({ id: 'user_new_123' });
    expect(dbInsertMock).toHaveBeenCalledOnce();

    const valuesCall = dbInsertMock.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    expect(valuesCall).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'fresh@example.com',
        provider: 'email',
        role: 'user',
        tokenVersion: 1,
        tosAcceptedAt,
        // Default name derives from the local part of the email so empty
        // 'name' (which is notNull in the schema) never blocks creation.
        name: 'fresh',
      }),
    );
  });

  it('given a unique-constraint race (concurrent magic-link request landed first), re-loads the surviving id and returns it', async () => {
    returningMock.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "users_email_unique"'),
    );
    selectWhereMock.mockResolvedValueOnce([{ id: 'user_existing_456' }]);

    const ports = buildMagicLinkPorts();
    const result = await ports.createUserAccount({
      email: 'racey@example.com',
      tosAcceptedAt: new Date(),
    });

    expect(result).toEqual({ id: 'user_existing_456' });
    expect(dbSelectMock).toHaveBeenCalledOnce();
  });

  it('given a non-constraint error, propagates it (caller sees the failure rather than a silent no-op)', async () => {
    const dbDown = new Error('connection refused');
    returningMock.mockRejectedValueOnce(dbDown);

    const ports = buildMagicLinkPorts();
    await expect(
      ports.createUserAccount({ email: 'u@example.com', tosAcceptedAt: new Date() }),
    ).rejects.toThrow(/connection refused/);
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('given a constraint error but the post-race lookup finds no row (storage anomaly), rethrows the original error', async () => {
    const constraintErr = new Error('unique constraint violation');
    returningMock.mockRejectedValueOnce(constraintErr);
    selectWhereMock.mockResolvedValueOnce([]);

    const ports = buildMagicLinkPorts();
    await expect(
      ports.createUserAccount({ email: 'u@example.com', tosAcceptedAt: new Date() }),
    ).rejects.toThrow(constraintErr);
  });

  it('given an email with no local part (defensive — schema rejects upstream, but adapter must not crash), falls back to a non-empty name', async () => {
    returningMock.mockResolvedValueOnce([{ id: 'user_x' }]);

    const ports = buildMagicLinkPorts();
    await ports.createUserAccount({
      email: '@example.com',
      tosAcceptedAt: new Date(),
    });

    const valuesCall = dbInsertMock.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    const inserted = valuesCall.mock.calls[0][0] as { name: string };
    expect(inserted.name).toBeTruthy();
  });
});
