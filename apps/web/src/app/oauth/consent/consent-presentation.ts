/**
 * What the consent screen says about WHO is asking (ADR 0004 Decision 8).
 * Pure over the resolved client, so the rule the screen renders is testable
 * without rendering it.
 *
 * The screen is part of the security boundary (ADR 0002 Decision 5): a badge
 * the user reads is a claim. "Built by PageSpace" is decided by `firstParty`
 * alone — which only exists in code — and "Unverified app" by `verified` alone,
 * independently, so neither can imply the other.
 */
import type { RegisteredClient } from '@pagespace/lib/auth/oauth/clients';

export interface ConsentClientPresentation {
  readonly name: string;
  readonly logoUrl?: string;
  readonly homepage?: { readonly href: string; readonly host: string };
  readonly builtByPageSpace: boolean;
  readonly unverified: boolean;
}

/**
 * Registration already refuses anything but https for both fields; this is the
 * render-time half, so a row written some other way still cannot put a
 * `javascript:` link or a mixed-content image on the consent screen.
 */
function httpsUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    return url;
  } catch {
    return null;
  }
}

export function consentClientPresentation(
  client: Pick<RegisteredClient, 'name' | 'firstParty' | 'verified' | 'logoUrl' | 'homepageUrl'>,
): ConsentClientPresentation {
  // Only a human-verified app's logo loads (point guard ruling, interim until
  // [D-13]). A logo is a request from the viewer's browser to a host the app
  // controls: for a self-registered app that is a tracking beacon telling the
  // registrant when a victim opened the authorize link, and from which IP.
  const logo = client.verified === true ? httpsUrl(client.logoUrl) : null;
  const homepage = httpsUrl(client.homepageUrl);
  return {
    name: client.name,
    ...(logo ? { logoUrl: logo.href } : {}),
    ...(homepage ? { homepage: { href: homepage.href, host: homepage.host } } : {}),
    builtByPageSpace: client.firstParty,
    unverified: !client.verified,
  };
}
