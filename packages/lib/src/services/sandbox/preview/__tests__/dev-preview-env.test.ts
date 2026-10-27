/**
 * The dev-preview KILL SWITCH and the preview apex — the two reads every
 * entry point in this feature asks first, and the reason a deployment that
 * has not been configured has no preview surface at all rather than a broken
 * one.
 *
 * Worth its own test because both fail CLOSED in ways that are easy to
 * regress into failing open: the switch admits exactly the string `'true'`,
 * and the apex has no default AND rejects an apex that shares a registrable
 * domain with the app — the property that stops a dev server's own JavaScript
 * setting cookies on the dashboard.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { isDevPreviewEnabled, isDevPreviewConfigured, resolveDevPreviewApex } from '../dev-preview-env';

const KEYS = ['DEV_PREVIEW_ENABLED', 'DEV_PREVIEW_APEX', 'WEB_APP_URL'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('the dev-preview kill switch', () => {
  it('admits the literal string "true" and nothing else', () => {
    for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true'] as const) {
      setEnv({ DEV_PREVIEW_ENABLED: value });
      assert({ given: `DEV_PREVIEW_ENABLED=${JSON.stringify(value)}`, should: 'stay off', actual: isDevPreviewEnabled(), expected: false });
    }
    setEnv({ DEV_PREVIEW_ENABLED: 'true' });
    assert({ given: 'the literal "true"', should: 'be on', actual: isDevPreviewEnabled(), expected: true });
  });
});

describe('the preview apex', () => {
  it('has NO default — unset is not configured, which is what makes the feature dark', () => {
    setEnv({ DEV_PREVIEW_APEX: undefined, WEB_APP_URL: 'https://app.pagespace.ai' });
    assert({ given: 'no apex', should: 'resolve to null', actual: resolveDevPreviewApex(), expected: null });
  });

  it('resolves a dedicated apex, and refuses one that shares the app\'s host', () => {
    setEnv({ DEV_PREVIEW_APEX: 'pagespace.io', WEB_APP_URL: 'https://app.pagespace.ai' });
    assert({ given: 'a dedicated apex', should: 'resolve it', actual: resolveDevPreviewApex(), expected: 'pagespace.io' });

    // The whole point of the separate registrable domain: a dev server's own
    // JavaScript on a preview host must not be able to set cookies the
    // dashboard would send. An apex that IS the app's host is refused.
    setEnv({ DEV_PREVIEW_APEX: 'app.pagespace.ai', WEB_APP_URL: 'https://app.pagespace.ai' });
    assert({ given: "the app's own host as the apex", should: 'refuse it', actual: resolveDevPreviewApex(), expected: null });
  });

  it('survives an unparseable WEB_APP_URL rather than throwing', () => {
    setEnv({ DEV_PREVIEW_APEX: 'pagespace.io', WEB_APP_URL: 'not a url' });
    expect(() => resolveDevPreviewApex()).not.toThrow();
    assert({ given: 'a malformed app URL', should: 'still resolve the apex', actual: resolveDevPreviewApex(), expected: 'pagespace.io' });
  });
});

describe('isDevPreviewConfigured — the one question every entry point asks', () => {
  it('needs BOTH the switch and a usable apex; either alone is dark', () => {
    setEnv({ DEV_PREVIEW_ENABLED: 'true', DEV_PREVIEW_APEX: 'pagespace.io', WEB_APP_URL: 'https://app.pagespace.ai' });
    assert({ given: 'both set', should: 'be configured', actual: isDevPreviewConfigured(), expected: true });

    setEnv({ DEV_PREVIEW_ENABLED: 'true', DEV_PREVIEW_APEX: undefined, WEB_APP_URL: 'https://app.pagespace.ai' });
    assert({ given: 'the switch on but no apex', should: 'be dark', actual: isDevPreviewConfigured(), expected: false });

    setEnv({ DEV_PREVIEW_ENABLED: undefined, DEV_PREVIEW_APEX: 'pagespace.io', WEB_APP_URL: 'https://app.pagespace.ai' });
    assert({ given: 'an apex but the switch off', should: 'be dark', actual: isDevPreviewConfigured(), expected: false });
  });
});
