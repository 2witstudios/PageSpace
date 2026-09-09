/**
 * Capacitor `allowNavigation` is a grant of the NATIVE PLUGIN BRIDGE, not a
 * navigation allowlist. Asserted structurally against the config source.
 *
 * On Android every entry is folded into `allowedOriginRules`
 * (`Bridge.setAllowedOriginRules()`), which `MessageHandler` passes to
 * `WebViewCompat.addWebMessageListener(webView, "androidBridge", ...)`; from
 * there `postMessage` reaches `Bridge.callPluginMethod()` and every registered
 * plugin — `PageSpaceKeychain` over EncryptedSharedPreferences included. A
 * third-party host in that list hands a provider's consent page the user's
 * session store; a wildcard hands it to every subdomain that exists or ever
 * will, tenant hosts included. Two separate reviewers caught two separate
 * versions of exactly that regression in PR #2552. This file is what stops a
 * third.
 *
 * `server.url` is guarded for a related reason: `Bridge.setAllowedOriginRules()`
 * also puts `getServerUrl()` VERBATIM into the same rule set, and the rule
 * grammar (`SCHEME "://" [ HOSTNAME_PATTERN [ ":" PORT ] ]`) has no path
 * production. A `url` carrying `/dashboard` is not a rule; `MessageHandler`'s
 * catch for a rejected rule is `webView.addJavascriptInterface(this,
 * "androidBridge")`, which enforces no origin at all. So a path in `server.url`
 * may silently disable the allowlist this test protects. The landing path
 * belongs in `appStartPath`.
 *
 * This lives in `apps/web` rather than beside the configs because neither
 * mobile app is in the turbo test graph, and the web layer is the other half of
 * the same bridge (`@/lib/capacitor-bridge`). `deploy-order.guard.test.ts` in
 * `apps/realtime` is the precedent for guarding a file outside the package.
 *
 * Both files are read as TEXT, not imported: the configs import
 * `@capacitor/keyboard` at runtime, which is installed under each app's own
 * `node_modules`, not the workspace root, and a guard that depended on that
 * resolving would fail for reasons unrelated to the invariant. A regex over the
 * source is exactly as brittle as the idiom in `sheet-read-is-read-only.guard`
 * and no more.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS = resolve(HERE, '../../../..');

const CONFIGS = {
  android: readFileSync(resolve(APPS, 'android/capacitor.config.ts'), 'utf-8'),
  ios: readFileSync(resolve(APPS, 'ios/capacitor.config.ts'), 'utf-8'),
} as const;

/** The app's own apex; a subdomain of it is "own origin", anything else is third party. */
const OWN_APEX = 'pagespace.ai';

/**
 * What the SHIPPED iOS app lists today. This is a ratchet, not an endorsement:
 * the two provider hosts are a deliberate, imperfect tradeoff recorded in the
 * config's own comment (omitting them hands the consent screen to Safari, where
 * a successful sign-in lands the cookie in the wrong jar), and the bridge on iOS
 * is a `WKUserScript(forMainFrameOnly: true)` with no origin scoping at all
 * (`JSExport.swift:20`), so every entry here is a bridge grant just as on
 * Android. Additions fail this test. Removals pass — that is the direction the
 * open finding on the Android parity epic points, and when it lands, shrink
 * this constant to match.
 */
const IOS_KNOWN_ENTRIES = ['pagespace.ai', '*.pagespace.ai', 'accounts.google.com', 'appleid.apple.com'];

/**
 * Strip full-line `//` comments so a commented-out entry inside the array is
 * not read as live. Whole-line only: `https://` inside a string literal must
 * survive, and both configs are written with full-line comments.
 */
function stripLineComments(source: string): string {
  return source.replace(/^\s*\/\/[^\n]*/gm, '');
}

/** The string entries of `allowNavigation: [...]`, or null if the key is absent. */
function allowNavigationEntries(source: string): string[] | null {
  const match = /allowNavigation:\s*\[([^\]]*)\]/.exec(stripLineComments(source));
  if (!match) return null;
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** The value of `<key>: '<value>'` inside the `server: { ... }` block, or null. */
function serverString(source: string, key: string): string | null {
  const server = /server:\s*\{([\s\S]*?)\n {2}\},/.exec(stripLineComments(source));
  if (!server) return null;
  const match = new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(server[1]);
  return match ? match[1] : null;
}

function isOwnOrigin(host: string): boolean {
  return host === OWN_APEX || host.endsWith(`.${OWN_APEX}`);
}

describe('Android capacitor.config.ts — allowNavigation grants the native bridge', () => {
  const entries = allowNavigationEntries(CONFIGS.android);

  it('found the allowNavigation list (guard is actually scanning something)', () => {
    expect(entries).not.toBeNull();
    expect(entries!.length).toBeGreaterThan(0);
  });

  it('lists no third-party host', () => {
    // Every entry is handed the native plugin bridge, PageSpaceKeychain
    // included. A provider consent page must never be one of them; provider
    // pages belong in a Custom Tab with a bound callback.
    for (const host of entries ?? []) {
      expect(isOwnOrigin(host), `${host} is not an own-origin host`).toBe(true);
    }
  });

  it('contains no wildcard', () => {
    // '*.pagespace.ai' is a bridge grant to every subdomain that exists or
    // ever will, tenant hosts included, and top-level navigation to a
    // subdomain is not something the shell does (it loads /dashboard and
    // stays). If one is ever genuinely needed, the apex must stay beside it —
    // HostMask.Simple.matches() never matches a 2-component host against a
    // 3-component mask — and this assertion must be replaced by one naming
    // the specific subdomain.
    for (const host of entries ?? []) {
      expect(host.includes('*'), `${host} is a wildcard`).toBe(false);
    }
  });

  it('entries are bare hostnames — no scheme, port, or path', () => {
    // Bridge.setAllowedOriginRules() prefixes a bare host with `https://` and
    // takes anything containing `://` verbatim. Only the bare form is what the
    // comment on the list describes, and anything else is a rule someone
    // should have to justify in review.
    for (const host of entries ?? []) {
      expect(host, `${host} is not a bare hostname`).toMatch(/^[a-z0-9.-]+$/);
    }
  });
});

describe('Android capacitor.config.ts — server.url is an origin, the path is appStartPath', () => {
  const url = serverString(CONFIGS.android, 'url');
  const appStartPath = serverString(CONFIGS.android, 'appStartPath');
  const errorPath = serverString(CONFIGS.android, 'errorPath');

  it('found server.url', () => {
    expect(url).not.toBeNull();
  });

  it('server.url carries no path, query, or fragment', () => {
    // A path here is not expressible as an addWebMessageListener origin rule,
    // and the fallback for a rejected rule is an unscoped
    // addJavascriptInterface — see the file header.
    expect(url).toBe(new URL(url!).origin);
  });

  it('the landing path is appStartPath, and it is absolute', () => {
    // Bridge appends appStartPath after the server.url branch, so the app
    // still lands on /dashboard without a path ever entering the rule set.
    expect(appStartPath).not.toBeNull();
    expect(appStartPath!.startsWith('/')).toBe(true);
  });

  it('errorPath names the bundled retry shell', () => {
    // Without it BridgeWebViewClient.onReceivedError has no URL to load and a
    // failed load leaves the WebView on Chrome's own error page.
    expect(errorPath).toBe('index.html');
  });
});

describe('iOS capacitor.config.ts — allowNavigation is ratcheted, not endorsed', () => {
  const entries = allowNavigationEntries(CONFIGS.ios);

  it('found the allowNavigation list (guard is actually scanning something)', () => {
    expect(entries).not.toBeNull();
    expect(entries!.length).toBeGreaterThan(0);
  });

  it('adds no entry beyond the recorded shipped set', () => {
    // A new host here is a new bridge grant on the shipped app. Removing one
    // is allowed and expected; adding one needs the tradeoff in the config
    // comment re-argued for that host, and this constant updated with it.
    for (const host of entries ?? []) {
      expect(IOS_KNOWN_ENTRIES, `${host} is not in the recorded iOS set`).toContain(host);
    }
  });

  it('the apex stays listed whenever the wildcard is', () => {
    // doesHost() compares dot-component counts, so '*.pagespace.ai' (3) never
    // matches 'pagespace.ai' (2). Dropping the apex while keeping the wildcard
    // re-creates the PR #2010 brick for every apex navigation.
    if (entries?.includes(`*.${OWN_APEX}`)) {
      expect(entries).toContain(OWN_APEX);
    }
  });
});
