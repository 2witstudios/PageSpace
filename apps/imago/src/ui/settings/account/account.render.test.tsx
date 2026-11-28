import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { accountLinks } from '../settings-model/settings-model';
import { renderAccount } from './account.render';

const linksIn = (html: string): string[] =>
  [...html.matchAll(/<a href="([^"]+)"[^>]*data-account-link="([^"]+)"/g)].map(([, href, id]) => `${id} ${href}`);

describe('renderAccount', () => {
  test('links into classic settings', () => {
    const html = renderToStaticMarkup(renderAccount({ links: accountLinks({ billing: true }) }));
    assert({
      given: 'the account object where billing is on',
      should: "link account, billing and connections to classic's settings as plain anchors outside imago's basePath",
      actual: linksIn(html),
      expected: ['account /settings/account', 'billing /settings/billing', 'connections /settings/integrations'],
    });
  });

  test('without billing', () => {
    const html = renderToStaticMarkup(renderAccount({ links: accountLinks({ billing: false }) }));
    assert({
      given: 'a deployment without in-app billing',
      should: 'not link to billing',
      actual: linksIn(html),
      expected: ['account /settings/account', 'connections /settings/integrations'],
    });
  });
});
