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

const { sendEmailMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: sendEmailMock,
}));

vi.mock('@pagespace/lib/email-templates/MagicLinkEmail', () => ({
  MagicLinkEmail: () => null,
}));

vi.mock('@pagespace/db/db', () => ({
  db: { insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })) },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  verificationTokens: {},
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
    const args = sendEmailMock.mock.calls[0]?.[0] as {
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

    const args = sendEmailMock.mock.calls[0]?.[0] as {
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

    const args = sendEmailMock.mock.calls[0]?.[0] as {
      react: { props: { magicLinkUrl: string } };
    };
    const url = args.react.props.magicLinkUrl;
    expect(url).toContain('token=tok');
    expect(url).toContain('next=%2Fdashboard%3Fwelcome%3D1%23top');
  });
});
