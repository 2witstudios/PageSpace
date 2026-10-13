'use client';

// The storage screen (C-Account-Storage): the viewer's quota, what their files take up by type and drive,
// and their largest and newest files. Every figure is the summary apps/web sends (GET /api/storage/info).
// Recalculate asks the server to reconcile stored usage, which only an admin may do, so it is shown to admins only.

import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { SettingsGroup, SettingsRow, SettingsScreen, SettingsSection } from '../settings-screen/settings-screen';
import { bytesLabel, STORAGE_INFO, storageOf, type StorageFile, type StorageType, type StorageView } from './account-storage-model';

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
export function AccountStorageView({ storage, isAdmin, reconciling, onRecalculate }: AccountStorageViewProps) {
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

/** The screen's own figures from apps/web; Recalculate reconciles the stored usage and shows what it returns. */
export function AccountStorage({ isAdmin }: { readonly isAdmin: boolean }) {
  const { data, mutate } = useSWR<unknown>(STORAGE_INFO);
  const [reconciling, setReconciling] = useState(false);

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
    />
  );
}
