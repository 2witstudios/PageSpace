import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const contactsList = vi.fn();
const contactsUpdate = vi.fn();
const contactsCreate = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    contacts = { list: contactsList, update: contactsUpdate, create: contactsCreate };
  },
}));
vi.mock('../../../logging/logger-config', () => ({
  loggers: { auth: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));

import { listSuppressedEmails } from '../resend-suppression-client';

const ORIGINAL_ENV = { ...process.env };

/** A page of contacts as the API returns it. */
const page = (
  contacts: Array<{ id: string; email: string; unsubscribed: boolean }>,
  has_more?: boolean,
) => ({
  data: { data: contacts, ...(has_more === undefined ? {} : { has_more }) },
  error: null,
});

/** `n` distinct unsubscribed contacts — enough to fill a page. */
const filledPage = (n: number, prefix = 'x') =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    email: `${prefix}${i}@example.com`,
    unsubscribed: true,
  }));

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
          { id: 'c1', email: 'Erased@Example.com', unsubscribed: true },
          { id: 'c2', email: 'active@example.com', unsubscribed: false },
          { id: 'c3', email: '  spaced@example.com  ', unsubscribed: true },
        ],
        has_more: false,
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

  it('given an empty audience, should return an empty set (not null)', async () => {
    contactsList.mockResolvedValue(page([], false));
    expect(await listSuppressedEmails()).toEqual(new Set());
  });

  it('should ask for the largest page Resend allows, not its 20-row default', async () => {
    contactsList.mockResolvedValue(page([], false));

    await listSuppressedEmails();

    expect(contactsList).toHaveBeenCalledWith({ audienceId: 'test-audience', limit: 100 });
  });

  describe('errors are never swallowed into a short list', () => {
    it('given a provider error, should throw rather than report an empty suppression list', async () => {
      contactsList.mockResolvedValue({ data: null, error: { message: 'rate limited' } });
      await expect(listSuppressedEmails()).rejects.toThrow(/rate limited/);
    });

    it('given a response with no contact array, should throw', async () => {
      contactsList.mockResolvedValue({ data: {}, error: null });
      await expect(listSuppressedEmails()).rejects.toThrow(/contact array/);
    });
  });

  describe('completeness is proven, not assumed', () => {
    it('given an audience spanning several pages, should page until has_more is false', async () => {
      contactsList
        .mockResolvedValueOnce(page([{ id: 'c1', email: 'one@example.com', unsubscribed: true }], true))
        .mockResolvedValueOnce(page([{ id: 'c2', email: 'two@example.com', unsubscribed: true }], true))
        .mockResolvedValueOnce(page([{ id: 'c3', email: 'three@example.com', unsubscribed: true }], false));

      expect(await listSuppressedEmails()).toEqual(
        new Set(['one@example.com', 'two@example.com', 'three@example.com']),
      );
      expect(contactsList).toHaveBeenCalledTimes(3);
    });

    it('should advance the cursor by the last contact id of the previous page', async () => {
      contactsList
        .mockResolvedValueOnce(page([{ id: 'c1', email: 'one@example.com', unsubscribed: true }], true))
        .mockResolvedValueOnce(page([{ id: 'c2', email: 'two@example.com', unsubscribed: true }], false));

      await listSuppressedEmails();

      expect(contactsList).toHaveBeenNthCalledWith(1, { audienceId: 'test-audience', limit: 100 });
      expect(contactsList).toHaveBeenNthCalledWith(2, {
        audienceId: 'test-audience',
        limit: 100,
        after: 'c1',
      });
    });

    it('given an error midway through pagination, should throw rather than return the pages it already read', async () => {
      contactsList
        .mockResolvedValueOnce(page([{ id: 'c1', email: 'one@example.com', unsubscribed: true }], true))
        .mockResolvedValueOnce({ data: null, error: { message: 'upstream exploded' } });

      await expect(listSuppressedEmails()).rejects.toThrow(/upstream exploded/);
    });

    it('given has_more with no cursor to advance from, should throw rather than truncate', async () => {
      contactsList.mockResolvedValue(page([], true));
      await expect(listSuppressedEmails()).rejects.toThrow(/no cursor/);
    });

    it('given a response with NO has_more flag, should throw rather than assume it is complete', async () => {
      // The dangerous shape. `has_more` absent is not "no more pages" — it is a
      // response we do not recognize, and guessing is how a suppression list gets
      // silently truncated and erased users get mailed. This must hold even for a
      // short page: we cannot prove the server honored our `limit`.
      contactsList.mockResolvedValue({
        data: { data: [{ id: 'c1', email: 'one@example.com', unsubscribed: true }] },
        error: null,
      });

      await expect(listSuppressedEmails()).rejects.toThrow(/no `has_more` flag/);
    });

    it('given an API that never stops paging, should throw instead of looping forever', async () => {
      // Every page is full, distinct, and claims there's more.
      let n = 0;
      contactsList.mockImplementation(async () => page(filledPage(100, `p${n++}-`), true));

      await expect(listSuppressedEmails()).rejects.toThrow(/exceeded 1000 pages/);
    });
  });
});
