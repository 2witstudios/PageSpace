import { describe, it, expect } from 'vitest';
import { resolveDestination, type StoredNotification } from '../resolve-destination';
import { getNotificationIcon } from '@/components/notifications/notificationIcons';
import { FileText } from 'lucide-react';

const base = { id: 'n1', userId: 'u-jono', isRead: false, createdAt: new Date('2026-09-14T00:00:00Z'), title: 't', message: 'm' } as const;
const note = (over: Partial<StoredNotification>): StoredNotification => ({ ...base, type: 'WALLET_CAP_ALERT', ...over }) as StoredNotification;

describe('wallet notifications in the notification UI', () => {
  it('WAL-7 (partial) a cap alert on a drive wallet opens that drive\'s Wallet settings, where the funder sets caps', () => {
    expect(resolveDestination(note({ type: 'WALLET_CAP_ALERT', driveId: 'd-product', drive: { id: 'd-product', slug: 'p', name: 'Product' }, metadata: { walletId: 'w', consumerId: 'u', window: 'daily', threshold: 80 } })))
      .toBe('/dashboard/d-product/settings/wallet');
  });

  it('WAL-7 (partial) a cap alert on a seat (no drive) opens Settings › Usage › Wallets', () => {
    expect(resolveDestination(note({ type: 'WALLET_CAP_ALERT', driveId: null, metadata: { walletId: 'w-pool', consumerId: 'u', window: 'monthly', threshold: 100 } })))
      .toBe('/settings/usage/wallets');
  });

  it('WAL-6 (partial) a wallet-debt notice opens the wallet it is about', () => {
    expect(resolveDestination(note({ type: 'WALLET_DEBT', driveId: 'd-product', metadata: { walletId: 'w' } }))).toBe('/dashboard/d-product/settings/wallet');
    expect(resolveDestination(note({ type: 'WALLET_DEBT', driveId: null, metadata: { walletId: 'w-pool' } }))).toBe('/settings/usage/wallets');
  });

  it('SPEND-6 (partial) a skipped-automation notice opens the drive\'s workflows', () => {
    expect(resolveDestination(note({ type: 'AUTOMATION_SKIPPED', driveId: 'd-product', metadata: { walletId: 'w', reason: 'drive_wallet_empty' } }))).toBe('/dashboard/d-product/workflows');
  });

  it('WAL-7 (partial) each wallet notification has its own icon, not the generic page icon', () => {
    for (const type of ['WALLET_CAP_ALERT', 'WALLET_DEBT', 'AUTOMATION_SKIPPED']) expect(getNotificationIcon(type)).not.toBe(FileText);
  });
});
