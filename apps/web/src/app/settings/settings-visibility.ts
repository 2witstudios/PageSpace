import type { SettingsItem } from './SettingsRow';

interface SettingsVisibilityContext {
  isDesktop: boolean;
  hideBilling: boolean;
  isNative: boolean;
}

export const filterSettingsItems = (
  items: SettingsItem[],
  { isDesktop, hideBilling, isNative }: SettingsVisibilityContext,
): SettingsItem[] =>
  items.filter((item) => {
    if (item.desktopOnly && !isDesktop) return false;
    if (item.mobileHidden && hideBilling) return false;
    if (item.nativeHidden && isNative) return false;
    return true;
  });
