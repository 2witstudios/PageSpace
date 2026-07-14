import { describe, it, expect } from 'vitest';
import { SdkCliLaunchEmail } from '../SdkCliLaunchEmail';
import { renderEmailToHtml } from '../render-email';

const PROPS = {
  userName: 'Ada',
  sdkDocsUrl: 'https://pagespace.ai/docs/features/sdk',
  cliDocsUrl: 'https://pagespace.ai/docs/features/cli',
  unsubscribeUrl: 'https://app.pagespace.ai/api/notifications/unsubscribe/ps_unsub_abc',
  postalAddress: 'PageSpace, 1 Example St, Springfield, IL 62704',
};

const render = (props: Partial<typeof PROPS> = {}) =>
  renderEmailToHtml(SdkCliLaunchEmail({ ...PROPS, ...props }));

describe('SdkCliLaunchEmail', () => {
  it('given the launch props, should name both packages and show how to install them', async () => {
    const html = await render();

    expect(html).toContain('@pagespace/sdk');
    expect(html).toContain('@pagespace/cli');
    expect(html).toContain('npm install @pagespace/sdk');
    expect(html).toContain('npm install -g @pagespace/cli');
  });

  it('given docs URLs, should link both of them', async () => {
    const html = await render();

    expect(html).toContain('https://pagespace.ai/docs/features/sdk');
    expect(html).toContain('https://pagespace.ai/docs/features/cli');
  });

  it('given an unsubscribe URL, should render the opt-out link', async () => {
    const html = await render();

    expect(html).toContain('/api/notifications/unsubscribe/ps_unsub_abc');
    expect(html).toContain('Unsubscribe');
  });

  it('given no unsubscribe URL, should omit the link rather than render a dead one', async () => {
    const html = await render({ unsubscribeUrl: undefined });

    expect(html).not.toContain('Unsubscribe');
  });

  it('given a postal address, should print it in the footer (CAN-SPAM)', async () => {
    // This is a commercial email, not a transactional one, so the sender's
    // physical address is legally required in the message itself.
    const html = await render();

    expect(html).toContain('1 Example St, Springfield, IL 62704');
  });

  it('given a recipient name, should greet them by it', async () => {
    // React inserts <!-- --> text separators around interpolated values, so the
    // greeting is asserted on its parts rather than as one literal string.
    const html = await render({ userName: 'Grace' });

    expect(html).toContain('Grace');
    expect(html).toMatch(/Hi\s*(<!--\s*-->)?\s*Grace/);
  });
});
