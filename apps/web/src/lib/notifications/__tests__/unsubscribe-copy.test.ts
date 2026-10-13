import { describe, it, expect, afterEach, vi } from 'vitest';
import { NOTIFICATION_TYPE_LABELS, getNotificationPreferencesHref } from '../unsubscribe-copy';

describe('unsubscribe-copy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given the shared label map, should label the three email types the edge pages show', () => {
    expect(NOTIFICATION_TYPE_LABELS.NEW_DIRECT_MESSAGE).toBe('Direct Messages');
    expect(NOTIFICATION_TYPE_LABELS.PAGE_SHARED).toBe('Page Shared');
    expect(NOTIFICATION_TYPE_LABELS.PRODUCT_UPDATE).toBe('Product Updates');
  });

  it('given Imago is off, should point preference links at the classic settings page', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', undefined);
    expect(getNotificationPreferencesHref()).toBe('/settings/notifications');
  });

  it('given Imago is on, should point preference links at /imago/account/notifications', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    expect(getNotificationPreferencesHref()).toBe('/imago/account/notifications');
  });
});
