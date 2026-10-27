import { describe, it, expect } from 'vitest';
import { FreeCreditsChangeEmail } from '../FreeCreditsChangeEmail';
import { renderEmailToHtml } from '../render-email';

const PROPS = {
  userName: 'Ada',
  currentCredits: '3.2',
  starterCredits: '5',
  proMonthlyCredits: '15',
  minTopup: '$5',
  planUrl: 'https://app.pagespace.ai/settings/plan',
  usageUrl: 'https://app.pagespace.ai/settings/usage',
  unsubscribeUrl: 'https://app.pagespace.ai/api/notifications/unsubscribe/ps_unsub_abc',
  postalAddress: 'PageSpace, 1 Example St, Springfield, IL 62704',
};

type Props = Parameters<typeof FreeCreditsChangeEmail>[0];

const render = (props: Partial<Props> = {}) =>
  renderEmailToHtml(FreeCreditsChangeEmail({ ...PROPS, ...props }));

describe('FreeCreditsChangeEmail', () => {
  it('given the change props, should say the grant is one-time and no longer refills', async () => {
    const html = await render();

    expect(html).toContain('one-time grant');
    expect(html).toContain('is not renewed');
    expect(html).not.toContain('/month');
    expect(html).toContain('keep the Free plan available');
  });

  it('given a current balance, should tell the recipient exactly what they keep', async () => {
    const html = await render({ currentCredits: '3.2' });

    expect(html).toMatch(/You have[\s\S]{0,40}3\.2[\s\S]{0,40}credits\./);
    expect(html).toContain('do not expire');
  });

  it('given a negative balance, should say how far in the red and that a top-up clears it — never "You have -0.3 credits"', async () => {
    const html = await render({ currentCredits: undefined, overageCredits: '0.3' });

    expect(html).toMatch(/balance is[\s\S]{0,40}0\.3[\s\S]{0,40}credits in the red/);
    expect(html).toContain('top-up clears the overage');
    expect(html).not.toContain('You have');
  });

  it('given no balance (never used AI), should say the starter credits are still waiting', async () => {
    const html = await render({ currentCredits: undefined });

    expect(html).toContain('have not used AI yet');
    expect(html).not.toContain('You have 3.2');
  });

  it('given plan and usage URLs, should link both the plan CTA and buy-credits path', async () => {
    const html = await render();

    expect(html).toContain('https://app.pagespace.ai/settings/plan');
    expect(html).toContain('https://app.pagespace.ai/settings/usage');
  });

  it('given the pricing props, should quote the top-up floor and the Pro allowance', async () => {
    const html = await render({ minTopup: '$5', proMonthlyCredits: '15' });

    expect(html).toMatch(/start at[\s\S]{0,40}\$5/);
    expect(html).toMatch(/includes[\s\S]{0,40}15[\s\S]{0,40}credits per month/);
  });

  it('given an unsubscribe URL, should render the opt-out link', async () => {
    // The send script skips anyone already opted out of PRODUCT_UPDATE and gives
    // everyone it does mail a working one-click opt-out.
    const html = await render();

    expect(html).toContain('/api/notifications/unsubscribe/ps_unsub_abc');
    expect(html).toContain('Unsubscribe');
  });

  it('given no unsubscribe URL, should omit the link rather than render a dead one', async () => {
    const html = await render({ unsubscribeUrl: undefined });

    expect(html).not.toContain('Unsubscribe');
  });

  it('given a postal address, should print it in the footer; given none, should omit it', async () => {
    expect(await render()).toContain('1 Example St, Springfield, IL 62704');
    expect(await render({ postalAddress: undefined })).not.toContain('Springfield');
  });

  it('given a recipient name, should greet them by it', async () => {
    const html = await render({ userName: 'Grace' });

    expect(html).toMatch(/Hi[\s\S]{0,40}Grace/);
  });
});
