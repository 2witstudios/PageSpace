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
    contactsList.mockResolvedValue({ data: { data: [], has_more: false }, error: null });
    expect(await listSuppressedEmails()).toEqual(new Set());
  });

  // Resend returns at most 100 contacts per page (only 20 by default). A partial
  // audience is indistinguishable from a complete one, so a paging bug here means
  // silently mailing every erased user past the first page.
  describe('pagination', () => {
    it('given an audience spanning several pages, should page until has_more is false', async () => {
      contactsList
        .mockResolvedValueOnce({
          data: {
            data: [{ id: 'c1', email: 'one@example.com', unsubscribed: true }],
            has_more: true,
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            data: [{ id: 'c2', email: 'two@example.com', unsubscribed: true }],
            has_more: true,
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            data: [{ id: 'c3', email: 'three@example.com', unsubscribed: true }],
            has_more: false,
          },
          error: null,
        });

      expect(await listSuppressedEmails()).toEqual(
        new Set(['one@example.com', 'two@example.com', 'three@example.com']),
      );
      expect(contactsList).toHaveBeenCalledTimes(3);
    });

    it('should request the maximum page size and advance the cursor by the last contact id', async () => {
      contactsList
        .mockResolvedValueOnce({
          data: { data: [{ id: 'c1', email: 'one@example.com', unsubscribed: true }], has_more: true },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { data: [{ id: 'c2', email: 'two@example.com', unsubscribed: true }], has_more: false },
          error: null,
        });

      await listSuppressedEmails();

      expect(contactsList).toHaveBeenNthCalledWith(1, {
        audienceId: 'test-audience',
        limit: 100,
      });
      expect(contactsList).toHaveBeenNthCalledWith(2, {
        audienceId: 'test-audience',
        limit: 100,
        after: 'c1',
      });
    });

    it('given a mid-pagination error, should throw rather than return the pages it already read', async () => {
      contactsList
        .mockResolvedValueOnce({
          data: { data: [{ id: 'c1', email: 'one@example.com', unsubscribed: true }], has_more: true },
          error: null,
        })
        .mockResolvedValueOnce({ data: null, error: { message: 'upstream exploded' } });

      await expect(listSuppressedEmails()).rejects.toThrow(/upstream exploded/);
    });

    it('given has_more with no cursor to advance from, should throw rather than truncate', async () => {
      contactsList.mockResolvedValue({ data: { data: [], has_more: true }, error: null });

      await expect(listSuppressedEmails()).rejects.toThrow(/no cursor/);
    });
  });
});
