import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { decideNavigation } from '../decide-navigation.js';

const PUBLIC_V4 = '93.184.216.34';

describe('decideNavigation', () => {
  describe('scheme and URL shape', () => {
    it('refuses what is not a URL', () => {
      assert({
        given: 'a string that does not parse as a URL',
        should: 'deny as invalid',
        actual: decideNavigation({ url: 'not a url', resolvedAddresses: null, allowedOrigins: null }),
        expected: { verdict: 'deny', reason: 'invalid-url' },
      });
    });

    it('refuses every scheme outside the web transports', () => {
      const urls = ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'about:blank', 'ftp://example.com/', 'view-source:https://example.com'];
      assert({
        given: 'file, javascript, data, chrome, about, ftp and view-source URLs',
        should: 'deny each as a scheme that is not allowed',
        actual: urls.map((url) => decideNavigation({ url, resolvedAddresses: null, allowedOrigins: null })),
        expected: urls.map(() => ({ verdict: 'deny', reason: 'scheme-not-allowed' })),
      });
    });

    it('refuses URLs that carry credentials', () => {
      assert({
        given: 'a URL with userinfo, which renders as a lookalike of another host',
        should: 'deny it',
        actual: decideNavigation({ url: 'https://accounts.example.com@evil.test/', resolvedAddresses: null, allowedOrigins: null }),
        expected: { verdict: 'deny', reason: 'credentials-in-url' },
      });
    });
  });

  describe('internal surfaces (never reachable, whatever they resolve to)', () => {
    const internal = [
      'https://localhost/',
      'https://localhost./',
      'https://app.localhost/',
      'https://_api.internal/',
      'https://my-app.internal/',
      'https://metadata.google.internal/',
      'https://svc.flycast/',
      'https://fly.storage.tigris.dev/bucket',
      'https://bucket.t3.tigrisfiles.io/key',
      'https://printer.local/',
      'https://agent-sandbox-abc.sprites.app/',
      'https://SPRITES.APP/',
    ];
    it('refuses loopback names, the Fly internal surface, mDNS names and other sandboxes before any DNS lookup', () => {
      assert({
        given: 'hosts on the loopback, Fly-internal, Tigris, mDNS and Sprites surfaces',
        should: 'deny each as an internal host without asking for resolution',
        actual: internal.map((url) => decideNavigation({ url, resolvedAddresses: null, allowedOrigins: null })),
        expected: internal.map(() => ({ verdict: 'deny', reason: 'internal-host' })),
      });
    });
  });

  describe('IP literals', () => {
    const privateLiterals = [
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://172.16.5.4/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://017700000001/',
      'http://[::1]/',
      'http://[fdaa::3]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
    ];
    it('refuses private, loopback, link-local, CGNAT and reserved literals in every encoding', () => {
      assert({
        given: 'private and reserved IP literals, including integer, hex, octal and IPv4-mapped forms',
        should: 'deny each as a private address',
        actual: privateLiterals.map((url) => decideNavigation({ url, resolvedAddresses: null, allowedOrigins: null })),
        expected: privateLiterals.map(() => ({ verdict: 'deny', reason: 'private-address' })),
      });
    });

    it('allows a public literal and connects to exactly that address', () => {
      assert({
        given: 'a public IPv4 literal',
        should: 'allow without resolution and pin the connection to the literal',
        actual: decideNavigation({ url: 'https://8.8.8.8/', resolvedAddresses: null, allowedOrigins: null }),
        expected: { verdict: 'allow', transportOrigin: { secure: true, host: '8.8.8.8', port: 443 }, connectAddress: '8.8.8.8', connectAddresses: ['8.8.8.8'] },
      });
    });

    it('allows a public IPv6 literal', () => {
      assert({
        given: 'a public IPv6 literal',
        should: 'allow and pin the bare address',
        actual: decideNavigation({ url: 'https://[2606:4700:4700::1111]/', resolvedAddresses: null, allowedOrigins: null }),
        expected: {
          verdict: 'allow',
          transportOrigin: { secure: true, host: '[2606:4700:4700::1111]', port: 443 },
          connectAddress: '2606:4700:4700::1111',
          connectAddresses: ['2606:4700:4700::1111'],
        },
      });
    });
  });

  describe('hostnames: resolve first, then decide on every address', () => {
    it('asks for resolution before deciding a hostname', () => {
      assert({
        given: 'a public hostname with no resolution yet',
        should: 'ask the caller to resolve that host',
        actual: decideNavigation({ url: 'https://Example.COM./path?q=1', resolvedAddresses: null, allowedOrigins: null }),
        expected: { verdict: 'resolve', host: 'example.com' },
      });
    });

    it('allows a hostname whose every address is public, pinned to the first', () => {
      assert({
        given: 'a hostname resolving only to public addresses',
        should: 'allow and pin the connection to the first address, so a second lookup cannot redirect it',
        actual: decideNavigation({ url: 'https://example.com/', resolvedAddresses: [PUBLIC_V4, '93.184.216.35'], allowedOrigins: null }),
        expected: { verdict: 'allow', transportOrigin: { secure: true, host: 'example.com', port: 443 }, connectAddress: PUBLIC_V4, connectAddresses: [PUBLIC_V4, '93.184.216.35'] },
      });
    });

    it('hands the caller every checked address, in order, to dial in turn', () => {
      const verdict = decideNavigation({ url: 'https://example.com/', resolvedAddresses: ['2606:2800:220:1::1', PUBLIC_V4], allowedOrigins: null });
      assert({
        given: 'a dual-stack answer with the IPv6 address first',
        should: 'list both checked addresses so an IPv4-only substrate can still connect',
        actual: verdict.verdict === 'allow' ? verdict.connectAddresses : verdict,
        expected: ['2606:2800:220:1::1', PUBLIC_V4],
      });
    });

    it('refuses a hostname resolving to a private address', () => {
      assert({
        given: 'a hostname resolving to 10.0.0.5',
        should: 'deny as a private address',
        actual: decideNavigation({ url: 'https://intranet.example.com/', resolvedAddresses: ['10.0.0.5'], allowedOrigins: null }),
        expected: { verdict: 'deny', reason: 'private-address' },
      });
    });

    it('refuses a rebinding host that answers with public and private addresses together', () => {
      assert({
        given: 'a hostname whose answer mixes a public and a loopback address',
        should: 'deny, since the connection could land on either',
        actual: decideNavigation({ url: 'https://rebind.example.com/', resolvedAddresses: [PUBLIC_V4, '127.0.0.1'], allowedOrigins: null }),
        expected: { verdict: 'deny', reason: 'private-address' },
      });
    });

    it('refuses a hostname resolving to an IPv4-mapped loopback', () => {
      assert({
        given: 'a hostname resolving to ::ffff:127.0.0.1',
        should: 'deny as a private address',
        actual: decideNavigation({ url: 'https://mapped.example.com/', resolvedAddresses: ['::ffff:127.0.0.1'], allowedOrigins: null }),
        expected: { verdict: 'deny', reason: 'private-address' },
      });
    });

    it('refuses a hostname that resolved to nothing', () => {
      assert({
        given: 'an empty resolution',
        should: 'deny as unresolved',
        actual: decideNavigation({ url: 'https://nx.example.com/', resolvedAddresses: [], allowedOrigins: null }),
        expected: { verdict: 'deny', reason: 'unresolved' },
      });
    });
  });

  describe('transport origins (secure-or-plaintext + host + port)', () => {
    it('treats plaintext http as its own transport on port 80', () => {
      assert({
        given: 'an http URL',
        should: 'allow it as a plaintext transport origin on port 80',
        actual: decideNavigation({ url: 'http://example.com/', resolvedAddresses: [PUBLIC_V4], allowedOrigins: null }),
        expected: { verdict: 'allow', transportOrigin: { secure: false, host: 'example.com', port: 80 }, connectAddress: PUBLIC_V4, connectAddresses: [PUBLIC_V4] },
      });
    });

    it('folds wss into the https unit and ws into the http unit', () => {
      assert({
        given: 'a wss and a ws URL on default ports',
        should: 'give the same transport origins as https and http',
        actual: [
          decideNavigation({ url: 'wss://example.com/socket', resolvedAddresses: [PUBLIC_V4], allowedOrigins: null }),
          decideNavigation({ url: 'ws://example.com/socket', resolvedAddresses: [PUBLIC_V4], allowedOrigins: null }),
        ],
        expected: [
          { verdict: 'allow', transportOrigin: { secure: true, host: 'example.com', port: 443 }, connectAddress: PUBLIC_V4, connectAddresses: [PUBLIC_V4] },
          { verdict: 'allow', transportOrigin: { secure: false, host: 'example.com', port: 80 }, connectAddress: PUBLIC_V4, connectAddresses: [PUBLIC_V4] },
        ],
      });
    });
  });

  describe('pinned origins (an account session is confined to its origins)', () => {
    const allowedOrigins = ['https://example.com'];

    it('allows the pinned origin and its secure websocket', () => {
      assert({
        given: 'a pin on https://example.com and requests to https and wss on it',
        should: 'allow both, since they are one transport origin',
        actual: [
          decideNavigation({ url: 'https://example.com/login', resolvedAddresses: [PUBLIC_V4], allowedOrigins }),
          decideNavigation({ url: 'wss://example.com/live', resolvedAddresses: [PUBLIC_V4], allowedOrigins }),
        ].map((v) => v.verdict),
        expected: ['allow', 'allow'],
      });
    });

    it('refuses another port, the plaintext transport, a subdomain and a lookalike, before any DNS lookup', () => {
      const urls = ['https://example.com:8443/', 'http://example.com/', 'https://sub.example.com/', 'https://example.com.evil.test/', 'https://evil-example.com/'];
      assert({
        given: 'requests outside the pinned transport origin',
        should: 'deny each as not allowed without resolving it',
        actual: urls.map((url) => decideNavigation({ url, resolvedAddresses: null, allowedOrigins })),
        expected: urls.map(() => ({ verdict: 'deny', reason: 'origin-not-allowed' })),
      });
    });

    it('fails closed on a malformed pin', () => {
      assert({
        given: 'an allowed-origins list whose only entry does not parse',
        should: 'deny the request rather than treat the pin as absent',
        actual: decideNavigation({ url: 'https://example.com/', resolvedAddresses: [PUBLIC_V4], allowedOrigins: ['::not an origin::'] }),
        expected: { verdict: 'deny', reason: 'origin-not-allowed' },
      });
    });

    it('still refuses a pinned origin that resolves privately', () => {
      assert({
        given: 'a pinned origin whose name now resolves to loopback',
        should: 'deny as a private address — a pin never widens the SSRF rules',
        actual: decideNavigation({ url: 'https://example.com/', resolvedAddresses: ['127.0.0.1'], allowedOrigins }),
        expected: { verdict: 'deny', reason: 'private-address' },
      });
    });
  });
});
