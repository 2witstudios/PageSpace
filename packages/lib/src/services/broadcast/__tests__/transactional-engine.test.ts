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
// Forwards its arguments on purpose: a mock that swallows them cannot catch a token minted
// for the wrong recipient or the wrong opt-out channel — which would unsubscribe someone
// from something they never asked about, or hand Ada a link that unsubscribes Grace.
const generateUnsubscribeToken = vi.fn<(userId: string, type: string) => Promise<string>>();

vi.mock('../../email-service', () => ({ sendEmail: (o: SendEmailOptions) => sendEmail(o) }));
vi.mock('../../notification-email-service', () => ({
  generateUnsubscribeToken: (userId: string, type: string) => generateUnsubscribeToken(userId, type),
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
  // A distinct token per recipient, so a reused or cross-wired token is visible.
  generateUnsubscribeToken.mockReset().mockImplementation(async (userId: string) => `tok_${userId}`);
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

    expect(generateUnsubscribeToken).toHaveBeenCalledWith('u1', 'PRODUCT_UPDATE');
    expect(sendEmail.mock.calls[0][0].headers).toEqual({
      'List-Unsubscribe': '<https://app.pagespace.ai/api/notifications/unsubscribe/tok_u1>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('should put the SAME unsubscribe URL in the body as in the header', async () => {
    // A header and a footer that disagree is an opt-out that works only by luck.
    await createTransactionalEngine(config).sendOne(recipient);

    const html = await renderEmailToHtml(
      sendEmail.mock.calls[0][0].react as React.ReactElement,
    );
    expect(html).toContain('https://app.pagespace.ai/api/notifications/unsubscribe/tok_u1');
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

  it('should mint a token for EACH recipient on their own channel, never a shared one', async () => {
    // Counting calls alone would pass even if both links unsubscribed the same person.
    const engine = createTransactionalEngine(config);
    await engine.sendOne(recipient);
    await engine.sendOne({ userId: 'u2', userName: 'Grace', email: 'grace@example.com' });

    expect(generateUnsubscribeToken.mock.calls).toEqual([
      ['u1', 'PRODUCT_UPDATE'],
      ['u2', 'PRODUCT_UPDATE'],
    ]);
    expect(sendEmail.mock.calls[0][0].headers?.['List-Unsubscribe']).toContain('tok_u1');
    expect(sendEmail.mock.calls[1][0].headers?.['List-Unsubscribe']).toContain('tok_u2');
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

  it('should render once per engine and reuse it — a dry run calls this once per audience row', async () => {
    // The output carries the placeholder token, not the recipient's, so it is
    // byte-identical for everyone; a 50k-row dry run must not pay 50k renders.
    const engine = createTransactionalEngine(config);
    const first = engine.renderOne(recipient);
    const second = engine.renderOne({ userId: 'u2', userName: 'Grace', email: 'grace@example.com' });

    expect(second).toBe(first);
    expect(await first).toContain('<strong>world</strong>');
  });
});

describe('transactional engine — preflight', () => {
  const base = {
    live: true,
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
  });

  it('should preflight the base URL it will actually SEND, not one handed to it', async () => {
    // The bug this pins: preflight validating one URL while sendOne built opt-out links
    // from another would bless a send that mails everyone a localhost link. The engine's
    // own config is the only source of truth, which is why the input carries no baseUrl.
    const localEngine = createTransactionalEngine({ ...config, baseUrl: 'http://localhost:3000' });

    await expect(localEngine.preflight(base)).resolves.toMatchObject({ ok: false });
  });

  it('should build the unsubscribe link from the same base URL preflight approved', async () => {
    const engine = createTransactionalEngine(config);
    await expect(engine.preflight(base)).resolves.toEqual({ ok: true });
    await engine.sendOne(recipient);

    expect(sendEmail.mock.calls[0][0].headers?.['List-Unsubscribe']).toContain(config.baseUrl);
  });
});