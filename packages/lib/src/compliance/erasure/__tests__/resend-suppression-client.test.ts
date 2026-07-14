import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const resendGet = vi.fn();
const contactsUpdate = vi.fn();
const contactsCreate = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    get = resendGet;
    contacts = { update: contactsUpdate, create: contactsCreate };
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
    resendGet.mockResolvedValue({
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
    expect(resendGet).not.toHaveBeenCalled();
  });

  it('given an empty audience, should return an empty set (not null)', async () => {
    resendGet.mockResolvedValue(page([], false));
    expect(await listSuppressedEmails()).toEqual(new Set());
  });

  it('should read the AUDIENCE resource that erasure writes to, not the segments alias', async () => {
    // resend@6's contacts.list({ audienceId }) silently rewrites to
    // /segments/{id}/contacts, while suppression writes go to /audiences/{id}/contacts.
    // Reading a different resource than we write to would report an empty
    // suppression list and mail every erased user.
    resendGet.mockResolvedValue(page([], false));

    await listSuppressedEmails();

    expect(resendGet).toHaveBeenCalledWith('/audiences/test-audience/contacts?limit=100');
  });

  describe('errors are never swallowed into a short list', () => {
    it('given a provider error, should throw rather than report an empty suppression list', async () => {
      resendGet.mockResolvedValue({ data: null, error: { message: 'rate limited' } });
      await expect(listSuppressedEmails()).rejects.toThrow(/rate limited/);
    });

    it('given a response with no contact array, should throw', async () => {
      resendGet.mockResolvedValue({ data: {}, error: null });
      await expect(listSuppressedEmails()).rejects.toThrow(/contact array/);
    });
  });

  describe('completeness is proven, not assumed', () => {
    it('given an audience spanning several pages, should page until has_more is false', async () => {
      resendGet
        .mockResolvedValueOnce(page([{ id: 'c1', email: 'one@example.com', unsubscribed: true }], true))
        .mockResolvedValueOnce(page([{ id: 'c2', email: 'two@example.com', unsubscribed: true }], true))
        .mockResolvedValueOnce(page([{ id: 'c3', email: 'three@example.com', unsubscribed: true }], false));

      expect(await listSuppressedEmails()).toEqual(
        new Set(['one@example.com', 'two@example.com', 'three@example.com']),
      );
      expect(resendGet).toHaveBeenCalledTimes(3);
    });

    it('should advance the cursor by the last contact id of the previous page', async () => {
      resendGet
        .mockResolvedValueOnce(page([{ id: 'c1', email: 'one@example.com', unsubscribed: true }], true))
        .mockResolvedValueOnce(page([{ id: 'c2', email: 'two@example.com', unsubscribed: true }], false));

      await listSuppressedEmails();

      expect(resendGet).toHaveBeenNthCalledWith(1, '/audiences/test-audience/contacts?limit=100');
      expect(resendGet).toHaveBeenNthCalledWith(2, '/audiences/test-audience/contacts?limit=100&after=c1');
    });

    it('given an error midway through pagination, should throw rather than return the pages it already read', async () => {
      resendGet
        .mockResolvedValueOnce(page([{ id: 'c1', email: 'one@example.com', unsubscribed: true }], true))
        .mockResolvedValueOnce({ data: null, error: { message: 'upstream exploded' } });

      await expect(listSuppressedEmails()).rejects.toThrow(/upstream exploded/);
    });

    it('given has_more with no cursor to advance from, should throw rather than truncate', async () => {
      resendGet.mockResolvedValue(page([], true));
      await expect(listSuppressedEmails()).rejects.toThrow(/no cursor/);
    });

    it('given a FULL page with no has_more flag, should throw — it may have been truncated', async () => {
      // The dangerous shape: exactly as many rows as we asked for and no paging
      // signal. Treating that as complete is how erased users past page 1 get mail.
      resendGet.mockResolvedValue({ data: { data: filledPage(100) }, error: null });

      await expect(listSuppressedEmails()).rejects.toThrow(/may be truncated/);
    });

    it('given a SHORT page with no has_more flag, should accept it as complete', async () => {
      // A short page cannot have been truncated, so no paging signal is needed.
      resendGet.mockResolvedValue({
        data: { data: [{ id: 'c1', email: 'one@example.com', unsubscribed: true }] },
        error: null,
      });

      expect(await listSuppressedEmails()).toEqual(new Set(['one@example.com']));
    });

    it('given an API that never stops paging, should throw instead of looping forever', async () => {
      // Every page is full, distinct, and claims there's more.
      let n = 0;
      resendGet.mockImplementation(async () => page(filledPage(100, `p${n++}-`), true));

      await expect(listSuppressedEmails()).rejects.toThrow(/exceeded 1000 pages/);
    });
  });
});
