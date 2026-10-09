import type { SettingsItem } from './SettingsRow';

interface SettingsVisibilityContext {
  isDesktop: boolean;
  showBilling: boolean;
  isNative: boolean;
}

export const filterSettingsItems = (
  items: SettingsItem[],
  { isDesktop, showBilling, isNative }: SettingsVisibilityContext,
): SettingsItem[] =>
  items.filter((item) => {
    if (item.desktopOnly && !isDesktop) return false;
    // !showBilling, not hideBilling: the latter stays false until platform detection
    // finishes, which flashed the Billing entry for a frame on iOS.
    if (item.mobileHidden && !showBilling) return false;
    if (item.nativeHidden && isNative) return false;
    return true;
  });
