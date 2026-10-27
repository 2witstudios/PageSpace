import type { SettingsItem } from './SettingsRow';
import type { BillingChannel } from '@/lib/billing/billing-visibility';

interface SettingsVisibilityContext {
  isDesktop: boolean;
  showBilling: boolean;
  isNative: boolean;
  /** Defaults to 'none': an Apple-only entry stays hidden unless the channel is known. */
  billingChannel?: BillingChannel;
}

export const filterSettingsItems = (
  items: SettingsItem[],
  { isDesktop, showBilling, isNative, billingChannel = 'none' }: SettingsVisibilityContext,
): SettingsItem[] =>
  items.filter((item) => {
    if (item.desktopOnly && !isDesktop) return false;
    // !showBilling, not hideBilling: the latter stays false until platform detection
    // finishes, which flashed the Billing entry for a frame on iOS.
    if (item.mobileHidden && !showBilling) return false;
    if (item.nativeHidden && isNative) return false;
    if (item.appleChannelOnly && billingChannel !== 'apple') return false;
    return true;
  });
