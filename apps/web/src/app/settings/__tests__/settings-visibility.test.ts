import { describe, it, expect } from 'vitest';
import { Cookie, CreditCard, Plug2 } from 'lucide-react';
import { filterSettingsItems } from '../settings-visibility';
import type { SettingsItem } from '../SettingsRow';

const item = (title: string, extra: Partial<SettingsItem> = {}): SettingsItem => ({
  title,
  description: title,
  icon: Cookie,
  href: `/settings/${title}`,
  available: true,
  ...extra,
});

const items = [
  item('privacy', { nativeHidden: true }),
  item('billing', { icon: CreditCard, mobileHidden: true }),
  item('mcp', { icon: Plug2, desktopOnly: true }),
  item('account'),
];

const titles = (list: SettingsItem[]) => list.map((i) => i.title);

describe('filterSettingsItems', () => {
  it('given the native app, should hide native-hidden entries like Privacy & Cookies', () => {
    expect(titles(filterSettingsItems(items, { isDesktop: false, hideBilling: true, isNative: true }))).toEqual(['account']);
  });

  it('given the web on a deployment without billing, should still show Privacy & Cookies', () => {
    expect(titles(filterSettingsItems(items, { isDesktop: false, hideBilling: true, isNative: false }))).toEqual(['privacy', 'account']);
  });

  it('given the desktop app with billing, should show everything but native-hidden-only exclusions', () => {
    expect(titles(filterSettingsItems(items, { isDesktop: true, hideBilling: false, isNative: false }))).toEqual(['privacy', 'billing', 'mcp', 'account']);
  });
});
