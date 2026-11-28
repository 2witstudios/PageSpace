import type { ReactNode } from 'react';
import { cn } from '../../cn';
import type { Banner, BannerTone } from './banner-registry';

/** The 36px strip above the tab bar: the control height token, a hairline under it, no shadow. */
const bannerClass = 'flex h-control flex-none items-center gap-3 overflow-hidden border-b px-4 text-xs';

const toneClass: Readonly<Record<BannerTone, string>> = {
  warning: 'border-status-warning/30 bg-status-warning/10 text-status-warning-ink',
  danger: 'border-status-danger/30 bg-status-danger/10 text-status-danger',
  info: 'border-hairline bg-tint text-ink-muted',
};

/** A banner's inline action, as a text button. */
export const bannerActionClass =
  'flex-none cursor-pointer rounded-md px-2 py-1 font-medium text-ink hover:bg-surface-overlay';

/** The slot's markup for the banner it shows, or nothing when no banner applies. */
export function renderBannerSlot(banner: Banner | null): ReactNode {
  if (banner === null) return null;
  return (
    <div role="status" data-slot="banner" data-banner={banner.id} data-tone={banner.tone} className={cn(bannerClass, toneClass[banner.tone])}>
      <span className="min-w-0 flex-1 truncate">{banner.message}</span>
      {banner.actions === undefined ? null : <span className="flex flex-none items-center gap-1">{banner.actions}</span>}
    </div>
  );
}
