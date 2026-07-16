/**
 * The engine that actually hands mail to Resend.
 *
 * Only the provider and the token mint are mocked — the email is really rendered, because
 * the properties worth pinning here (the unsubscribe footer exists, the headers point at
 * the same URL the body does, the idempotency key is stable) are all properties of the
 * thing that ships.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SendEmailOptions } from '../../email-service';

const sendEmail = vi.fn<(options: SendEmailOptions) => Promise<void>>();
const generateUnsubscribeToken = vi.fn<() => Promise<string>>();

vi.mock('../../email-service', () => ({ sendEmail: (o: SendEmailOptions) => sendEmail(o) }));
vi.mock('../../notification-email-service', () => ({
  generateUnsubscribeToken: () => generateUnsubscribeToken(),
}));

import { renderEmailToHtml } from '../../../email-templates/render-email';
import { broadcastIdempotencyKey, createTransactionalEngine } from '../transactional-engine';

const config = {
  broadcastId: 'b1',
  subject: 'Product update',
  bodyMarkdown: 'Hello **world** — [read more](https://pagespace.ai/docs)',
  notificationType: 'PRODUCT_UPDATE' as const,
  baseUrl: 'https://app.pagespace.ai',
  postalAddress: '1 Example St, Testville',
};

const recipient = { userId: 'u1', userName: 'Ada', email: 'ada@example.com' };

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue(undefined);
  generateUnsubscribeToken.mockReset().mockResolvedValue('tok_123');
});

describe('broadcastIdempotencyKey', () => {
  it('should be stable for a recipient, so a retried send collapses into the original', () => {
    expect(broadcastIdempotencyKey('b1', 'u1')).toBe('broadcast:b1:u1');
  });

  it('should be namespaced per broadcast, so a second campaign is a second email', () => {
    expect(broadcastIdempotencyKey('b2', 'u1')).not.toBe(broadcastIdempotencyKey('b1', 'u1'));
  });
});

describe('transactional engine — sendOne', () => {
  it('should send to the recipient with the broadcast subject', async () => {
    await createTransactionalEngine(config).sendOne(recipient);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      to: 'ada@example.com',
      subject: 'Product update',
      idempotencyKey: 'broadcast:b1:u1',
    });
  });

  it('should advertise one-click unsubscribe pointing at this recipient\'s token', async () => {
    // Gmail/Yahoo bulk rules require the header; a body link alone is not enough.
    await createTransactionalEngine(config).sendOne(recipient);

    expect(sendEmail.mock.calls[0][0].headers).toEqual({
      'List-Unsubscribe': '<https://app.pagespace.ai/api/notifications/unsubscribe/tok_123>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('should put the SAME unsubscribe URL in the body as in the header', async () => {
    // A header and a footer that disagree is an opt-out that works only by luck.
    await createTransactionalEngine(config).sendOne(recipient);

    const html = await renderEmailToHtml(
      sendEmail.mock.calls[0][0].react as React.ReactElement,
    );
    expect(html).toContain('https://app.pagespace.ai/api/notifications/unsubscribe/tok_123');
  });

  it('should render the author\'s markdown into the branded shell', async () => {
    await createTransactionalEngine(config).sendOne(recipient);

    const html = await renderEmailToHtml(sendEmail.mock.calls[0][0].react as React.ReactElement);
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('PageSpace');
  });

  it('should carry the postal address CAN-SPAM requires of commercial mail', async () => {
    await createTransactionalEngine(config).sendOne(recipient);

    const html = await renderEmailToHtml(sendEmail.mock.calls[0][0].react as React.ReactElement);
    expect(html).toContain('1 Example St, Testville');
  });

  it('given the provider throws, should propagate so the caller records a retryable failure', async () => {
    // sendEmail's 3/hr rate limit surfaces this way, and it must never look like a send.
    sendEmail.mockRejectedValue(new Error('Too many emails sent to ada@example.com'));

    await expect(createTransactionalEngine(config).sendOne(recipient)).rejects.toThrow(/Too many emails/);
  });

  it('should mint a fresh token per recipient rather than reuse one', async () => {
    const engine = createTransactionalEngine(config);
    await engine.sendOne(recipient);
    await engine.sendOne({ userId: 'u2', userName: 'Grace', email: 'grace@example.com' });

    expect(generateUnsubscribeToken).toHaveBeenCalledTimes(2);
  });
});

describe('transactional engine — renderOne', () => {
  it('should render the real email so a content error surfaces before the live send', async () => {
    const html = await createTransactionalEngine(config).renderOne(recipient);

    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('Unsubscribe');
  });

  it('should mint NO token — a dry run must not write to the database per previewed user', async () => {
    await createTransactionalEngine(config).renderOne(recipient);

    expect(generateUnsubscribeToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('transactional engine — preflight', () => {
  const base = {
    live: true,
    baseUrl: 'https://app.pagespace.ai',
    suppressed: new Set<string>(),
    isOnPrem: false,
    fromEmail: 'PageSpace <hello@pagespace.ai>',
  };

  it('should report its name for the engine enum', () => {
    expect(createTransactionalEngine(config).name).toBe('transactional');
  });

  it('given a well-configured live send, should allow it', async () => {
    await expect(createTransactionalEngine(config).preflight(base)).resolves.toEqual({ ok: true });
  });

  it('should enforce the shared core guards rather than a copy of them', async () => {
    // The engine may add guards; it may never skip the ones every engine shares.
    const engine = createTransactionalEngine(config);
    await expect(engine.preflight({ ...base, isOnPrem: true })).resolves.toMatchObject({ ok: false });
    await expect(engine.preflight({ ...base, suppressed: null })).resolves.toMatchObject({ ok: false });
    await expect(engine.preflight({ ...base, fromEmail: undefined })).resolves.toMatchObject({ ok: false });
    await expect(engine.preflight({ ...base, baseUrl: 'http://localhost:3000' })).resolves.toMatchObject({
      ok: false,
    });
  });
});