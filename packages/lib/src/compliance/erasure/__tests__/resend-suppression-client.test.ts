import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const contactsList = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    contacts = { list: contactsList, update: vi.fn(), create: vi.fn() };
  },
}));
vi.mock('../../../logging/logger-config', () => ({
  loggers: { auth: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));

import { listSuppressedEmails } from '../resend-suppression-client';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_AUDIENCE_ID = 'test-audience';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('listSuppressedEmails', () => {
  it('given unsubscribed contacts, should return only those, normalized', async () => {
    contactsList.mockResolvedValue({
      data: {
        data: [
          { email: 'Erased@Example.com', unsubscribed: true },
          { email: 'active@example.com', unsubscribed: false },
          { email: '  spaced@example.com  ', unsubscribed: true },
        ],
      },
      error: null,
    });

    expect(await listSuppressedEmails()).toEqual(
      new Set(['erased@example.com', 'spaced@example.com']),
    );
  });

  it('given no audience configured, should return null so callers can refuse to broadcast', async () => {
    delete process.env.RESEND_AUDIENCE_ID;
    expect(await listSuppressedEmails()).toBeNull();
    expect(contactsList).not.toHaveBeenCalled();
  });

  it('given a provider error, should throw rather than report an empty suppression list', async () => {
    // The dangerous failure mode: swallowing this into an empty Set would mail
    // every erased user. A bulk sender must see the failure.
    contactsList.mockResolvedValue({ data: null, error: { message: 'rate limited' } });

    await expect(listSuppressedEmails()).rejects.toThrow(/rate limited/);
  });

  it('given an empty audience, should return an empty set (not null)', async () => {
    contactsList.mockResolvedValue({ data: { data: [] }, error: null });
    expect(await listSuppressedEmails()).toEqual(new Set());
  });
});
