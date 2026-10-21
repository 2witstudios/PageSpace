'use client';

// The storage screen (C-Account-Storage): the viewer's quota, what their files take up by type and drive,
// and their largest and newest files. Every figure is the summary apps/web sends (GET /api/storage/info).
// Recalculate asks the server to reconcile stored usage, which only an admin may do, so it is shown to admins only.
// Extra storage (50 GB blocks, GET/POST /api/stripe/storage-addon) is sold through Stripe, so it shows where Stripe may sell.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { formatDollars } from '@pagespace/lib/billing/money-model';
import { fetchWithAuth, post } from '@/retained/lib/auth/auth-fetch';
import { useBillingVisibility } from '@/retained/hooks/useBillingVisibility';
import { StorageAddonDialog, type StorageAddonState } from '@/retained/components/billing/StorageAddonDialog';
import { SettingsGroup, SettingsRow, SettingsScreen, SettingsSection } from '../settings-screen/settings-screen';
import { bytesLabel, STORAGE_INFO, storageOf, type StorageFile, type StorageType, type StorageView } from './account-storage-model';

/** apps/web's personal storage add-on: the blocks held and what one costs (GET/POST /api/stripe/storage-addon). */
export const STORAGE_ADDON = '/api/stripe/storage-addon';

type PersonalStorageAddon = StorageAddonState & { readonly available: boolean; readonly tier: string };

const buttonClass =
  'inline-flex h-8 items-center rounded-lg border border-hairline px-3 text-sm text-ink hover:bg-tint disabled:opacity-50';

const SEGMENT_CLASS: Readonly<Record<StorageType['label'], string>> = {
  PDF: 'bg-type-doc',
  Images: 'bg-type-sheet',
  Video: 'bg-type-canvas',
  Other: 'bg-type-file',
};

const LEDE = 'Uploaded files in drives you own personally. Organization drives count against the organization.';

export type AccountStorageViewProps = {
  readonly storage: StorageView | null;
  readonly isAdmin: boolean;
  readonly reconciling: boolean;
  readonly onRecalculate: () => void;
  /** The extra-storage section, where storage can be bought or the plan upgraded; absent elsewhere. */
  readonly extraStorage?: ReactNode;
};

function FileRows({ files, empty }: { readonly files: readonly StorageFile[]; readonly empty: string }) {
  if (files.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <SettingsGroup>
      {files.map((file, index) => (
        <SettingsRow key={`${file.id}-${index}`} label={file.title} hint={file.detail} />
      ))}
    </SettingsGroup>
  );
}

/** The storage page's markup, given its figures: no requests, so it renders the same in every test. */
export function AccountStorageView({ storage, isAdmin, reconciling, onRecalculate, extraStorage }: AccountStorageViewProps) {
  return (
    <SettingsScreen
      title="Storage"
      lede={LEDE}
      actions={
        isAdmin ? (
          <button
            type="button"
            onClick={onRecalculate}
            disabled={reconciling}
            className="inline-flex h-8 items-center rounded-lg border border-hairline px-3 text-sm text-ink hover:bg-tint disabled:opacity-50"
          >
            Recalculate
          </button>
        ) : undefined
      }
    >
      {storage === null ? null : (
        <>
          <SettingsSection
            title={`${storage.tier} · ${storage.quota} quota`}
            description={`${storage.used} used · ${storage.available} available`}
          >
            {storage.types.length === 0 ? null : (
              <div
                role="img"
                aria-label={`Storage by type: ${storage.types
                  .map((type) => `${type.label === 'PDF' ? 'PDFs' : type.label} ${Math.round(type.percent)}%`)
                  .join(', ')} of used space`}
                className="flex h-2 overflow-hidden rounded-full bg-fill"
              >
                {storage.types.map((type) => (
                  <span key={type.label} className={SEGMENT_CLASS[type.label]} style={{ width: `${type.percent}%` }} />
                ))}
              </div>
            )}
            {storage.types.length === 0 ? null : (
              <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-muted">
                {storage.types.map((type) => (
                  <li key={type.label}>
                    {type.label} {bytesLabel(type.bytes)} · {type.count} {type.count === 1 ? 'file' : 'files'}
                  </li>
                ))}
              </ul>
            )}
            <SettingsGroup label="Limits">
              {storage.limits.map((limit) => (
                <SettingsRow key={limit.label} label={limit.label}>
                  <span className="text-sm tabular-nums text-ink">{limit.value}</span>
                </SettingsRow>
              ))}
            </SettingsGroup>
          </SettingsSection>

          {extraStorage}

          <SettingsSection title="By drive">
            {storage.drives.length === 0 ? (
              <p className="text-sm text-ink-muted">No drives hold your files yet.</p>
            ) : (
              <SettingsGroup>
                {storage.drives.map((drive) => (
                  <SettingsRow key={drive.driveId} label={drive.name} hint={`${drive.files} files`}>
                    <span className="text-sm tabular-nums text-ink">{drive.size}</span>
                  </SettingsRow>
                ))}
              </SettingsGroup>
            )}
          </SettingsSection>

          <SettingsSection title="Largest files">
            <FileRows files={storage.largest} empty="No files yet" />
          </SettingsSection>

          <SettingsSection title="Recent uploads">
            <FileRows files={storage.recent} empty="No files yet" />
          </SettingsSection>
        </>
      )}
    </SettingsScreen>
  );
}

const GB = 1024 ** 3;
const gbLabel = (bytes: number): string => `${Math.round(bytes / GB)} GB`;

const quotaBytesOf = (body: unknown): { quotaBytes: number; addonBytes: number; tier: string | null } | null => {
  const quota = typeof body === 'object' && body !== null ? (body as { quota?: unknown }).quota : null;
  if (typeof quota !== 'object' || quota === null) return null;
  const { quotaBytes, addonBytes, tier } = quota as { quotaBytes?: unknown; addonBytes?: unknown; tier?: unknown };
  if (typeof quotaBytes !== 'number' || !Number.isFinite(quotaBytes)) return null;
  return { quotaBytes, addonBytes: typeof addonBytes === 'number' && Number.isFinite(addonBytes) ? addonBytes : 0, tier: typeof tier === 'string' ? tier : null };
};

/**
 * Extra storage (classic Settings › Usage › Storage): Add or Change storage where the plan can hold
 * blocks, the date paid-through blocks drop, and an upgrade where the plan cannot (Free).
 */
function ExtraStorageSection({ addon, canUpgrade, onChange }: {
  readonly addon: PersonalStorageAddon | null;
  readonly canUpgrade: boolean;
  readonly onChange: () => void;
}) {
  const canBuy = addon?.available === true;
  if (!canBuy && !canUpgrade) return null;
  return (
    <SettingsSection
      title="Extra storage"
      description={addon && canBuy ? `Add storage in ${gbLabel(addon.blockBytes)} blocks at ${formatDollars(addon.blockPriceCents)}/month each, billed with your plan.` : 'More storage comes with a paid plan.'}
    >
      <SettingsGroup label="Extra storage">
        {addon && canBuy ? (
          <SettingsRow
            // entitledBlocks is what the quota holds now; blocks is the (possibly lower) next-period count.
            label={addon.entitledBlocks > 0 ? `+${gbLabel(addon.entitledBlocks * addon.blockBytes)} extra` : 'No extra storage'}
            hint={addon.graceUntil ? `Your extra storage drops to ${gbLabel(addon.blocks * addon.blockBytes)} on ${new Date(addon.graceUntil).toLocaleDateString()}.` : addon.blocks > 0 ? `${formatDollars(addon.blocks * addon.blockPriceCents)}/month` : undefined}
          >
            <button type="button" onClick={onChange} className={buttonClass}>
              {addon.entitledBlocks > 0 || addon.blocks > 0 ? 'Change storage' : 'Add storage'}
            </button>
          </SettingsRow>
        ) : (
          <SettingsRow label="Upgrade for more storage" hint="Pro raises your quota and file size limit.">
            <Link href="/account/plan" className={buttonClass}>See plans</Link>
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}

/** The screen's own figures from apps/web; Recalculate reconciles the stored usage and shows what it returns. */
export function AccountStorage({ isAdmin }: { readonly isAdmin: boolean }) {
  const { data, mutate } = useSWR<unknown>(STORAGE_INFO);
  const [reconciling, setReconciling] = useState(false);
  // Storage add-ons are Stripe-only; the upgrade goes to the plan page, which sells wherever a store may.
  const { showBilling, showPurchases } = useBillingVisibility();
  const { data: addon, mutate: mutateAddon } = useSWR<PersonalStorageAddon>(showBilling ? STORAGE_ADDON : null);
  const [addonOpen, setAddonOpen] = useState(false);
  const quota = quotaBytesOf(data);

  const changeAddon = async (blocks: number) => {
    const result = await post<{ charged: boolean }>(STORAGE_ADDON, { blocks });
    toast.success(result.charged ? 'Storage added' : 'Storage updated');
    await Promise.all([mutate(), mutateAddon()]);
  };

  const recalculate = async () => {
    setReconciling(true);
    try {
      const response = await fetchWithAuth(`${STORAGE_INFO}?reconcile=true`);
      if (!response.ok) throw new Error('Failed to reconcile storage');
      await mutate(await response.json(), { revalidate: false });
      toast.success('Storage data reconciled successfully');
    } catch {
      toast.error('Failed to recalculate storage');
    } finally {
      setReconciling(false);
    }
  };

  return (
    <AccountStorageView
      storage={storageOf(data)}
      isAdmin={isAdmin}
      reconciling={reconciling}
      onRecalculate={() => void recalculate()}
      extraStorage={
        quota === null ? null : (
          <>
            <ExtraStorageSection
              addon={showBilling ? addon ?? null : null}
              canUpgrade={showPurchases && quota.tier === 'free'}
              onChange={() => setAddonOpen(true)}
            />
            {addon && showBilling && addon.available ? (
              <StorageAddonDialog
                open={addonOpen}
                onOpenChange={setAddonOpen}
                addon={addon}
                baseQuotaBytes={quota.quotaBytes - quota.addonBytes}
                payerLabel="Your"
                onSubmit={changeAddon}
              />
            ) : null}
          </>
        )
      }
    />
  );
}
