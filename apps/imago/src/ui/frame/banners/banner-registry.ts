import type { ReactNode } from 'react';

/** The tones a banner can take (C-Shell-Banners): amber for a recoverable state, red for a blocked one. */
export type BannerTone = 'warning' | 'danger' | 'info';

export type Banner = {
  readonly id: string;
  /** Higher wins the slot; the 36px strip shows one banner at a time. */
  readonly priority: number;
  readonly tone: BannerTone;
  readonly message: ReactNode;
  /** Inline actions at the strip's trailing edge. */
  readonly actions?: ReactNode;
};

/** Each banner's rank in the slot. Add a banner here, and to AppBanner's candidates. */
export const bannerPriority = {
  offline: 90,
  conflict: 80,
  verifyEmail: 60,
} as const;

/**
 * The banner the slot shows: the highest priority among the candidates that are present. On a
 * tie the earlier candidate wins, so the order a caller lists them in breaks it.
 */
export function pickBanner(candidates: readonly (Banner | null)[]): Banner | null {
  return candidates.reduce<Banner | null>(
    (best, candidate) => (candidate !== null && (best === null || candidate.priority > best.priority) ? candidate : best),
    null,
  );
}
