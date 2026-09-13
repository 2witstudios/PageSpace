import { describe, it, expect } from 'vitest';
import { getRegisteredClient, PAGESPACE_CLI_CLIENT_ID, type RegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { consentClientPresentation } from '../consent-presentation';

const THIRD_PARTY: RegisteredClient = {
  clientId: 'app_swipesend',
  name: 'SwipeSend',
  type: 'public',
  redirectUris: ['https://swipesend.app/auth/pagespace/callback'],
  allowedGrantTypes: ['authorization_code'],
  allowedScopes: ['profile'],
  firstParty: false,
  verified: false,
  logoUrl: 'https://swipesend.app/logo.png',
  homepageUrl: 'https://swipesend.app/about',
};

describe('consentClientPresentation (ADR 0004 Decision 8)', () => {
  it('labels the first-party CLI "Built by PageSpace" and not unverified', () => {
    const presentation = consentClientPresentation(getRegisteredClient(PAGESPACE_CLI_CLIENT_ID)!);
    expect(presentation).toMatchObject({ name: 'PageSpace CLI', builtByPageSpace: true, unverified: false });
  });

  it('labels an unverified third-party app "Unverified app" and never "Built by PageSpace"', () => {
    expect(consentClientPresentation(THIRD_PARTY)).toEqual({
      name: 'SwipeSend',
      logoUrl: 'https://swipesend.app/logo.png',
      homepage: { href: 'https://swipesend.app/about', host: 'swipesend.app' },
      builtByPageSpace: false,
      unverified: true,
    });
  });

  it('drops the badge once a human has verified the app', () => {
    expect(consentClientPresentation({ ...THIRD_PARTY, verified: true }).unverified).toBe(false);
  });

  it('decides each badge on its own field — firstParty and verified are independent', () => {
    expect(consentClientPresentation({ ...THIRD_PARTY, firstParty: true, verified: false })).toMatchObject({
      builtByPageSpace: true,
      unverified: true,
    });
  });

  it('never renders a logo or homepage that is not https, whatever the record holds', () => {
    for (const bad of ['javascript:alert(1)', 'http://swipesend.app/logo.png', 'data:image/png;base64,AAAA', 'not a url', 'https://user:pw@swipesend.app/']) {
      const presentation = consentClientPresentation({ ...THIRD_PARTY, logoUrl: bad, homepageUrl: bad });
      expect(presentation.logoUrl).toBeUndefined();
      expect(presentation.homepage).toBeUndefined();
    }
  });

  it('omits presentation fields the client does not have', () => {
    const { logoUrl: _l, homepageUrl: _h, ...bare } = THIRD_PARTY;
    const presentation = consentClientPresentation(bare);
    expect(presentation).not.toHaveProperty('logoUrl');
    expect(presentation).not.toHaveProperty('homepage');
  });
});
