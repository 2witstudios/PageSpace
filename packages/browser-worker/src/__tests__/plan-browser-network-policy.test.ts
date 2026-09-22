import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { planBrowserNetworkPolicy } from '../plan-browser-network-policy.js';

const INTERNAL = [
  { domain: '_api.internal', action: 'deny' },
  { domain: '*.internal', action: 'deny' },
  { domain: 'flycast', action: 'deny' },
  { domain: '*.flycast', action: 'deny' },
  { domain: 'fly.storage.tigris.dev', action: 'deny' },
  { domain: '*.fly.storage.tigris.dev', action: 'deny' },
  { domain: 't3.tigrisfiles.io', action: 'deny' },
  { domain: '*.t3.tigrisfiles.io', action: 'deny' },
  { domain: 'sprites.app', action: 'deny' },
  { domain: '*.sprites.app', action: 'deny' },
];

describe('planBrowserNetworkPolicy', () => {
  it('opens the public web behind the internal and sandbox denies for an unpinned session', () => {
    assert({
      given: 'no pinned origins',
      should: 'deny the Fly internal surface and every Sprite edge URL, then allow the rest',
      actual: planBrowserNetworkPolicy({ allowedOrigins: null }),
      expected: { rules: [...INTERNAL, { domain: '*', action: 'allow' }] },
    });
  });

  it('allows only the pinned hosts, then denies everything, for a pinned session', () => {
    assert({
      given: 'pinned origins on two hosts, one repeated on another port',
      should: 'emit one allow per host (DNS cannot express scheme or port) and a final deny-all',
      actual: planBrowserNetworkPolicy({ allowedOrigins: ['https://example.com', 'https://example.com:8443', 'https://login.example.org'] }),
      expected: { rules: [...INTERNAL, { domain: 'example.com', action: 'allow' }, { domain: 'login.example.org', action: 'allow' }, { domain: '*', action: 'deny' }] },
    });
  });

  it('never lets a pin open the internal surface, a sandbox URL or a raw address', () => {
    assert({
      given: 'pins on an internal zone, a Sprite URL, an IP literal and a malformed entry',
      should: 'drop them all and deny everything',
      actual: planBrowserNetworkPolicy({ allowedOrigins: ['https://x.internal', 'https://agent.sprites.app', 'https://8.8.8.8', 'not a url'] }),
      expected: { rules: [...INTERNAL, { domain: '*', action: 'deny' }] },
    });
  });
});
