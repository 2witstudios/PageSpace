'use client';

import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';
import type { OrgRole } from '@/retained/lib/orgs/org-api';
import { Button } from '@/retained/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/retained/components/ui/card';
import { Progress } from '@/retained/components/ui/progress';
import { StorageAddonDialog, type StorageAddonState } from '@/retained/components/billing/StorageAddonDialog';
import { useOrgAdminRead } from '@/retained/hooks/useOrgs';
import { isOrgKey, orgReadKeys, setOrgStorageBlocks } from '@/retained/lib/orgs/org-api';
import { orgErrorMessage } from '@/retained/lib/orgs/org-error-copy';

/** GET /api/orgs/[orgId]/billing/storage */
interface OrgStorage extends StorageAddonState {
  available: boolean;
  unavailableReason: 'not_configured' | 'no_subscription' | 'lapsed' | 'gifted' | null;
  usedBytes: number;
  quotaBytes: number;
}

const GB = 1024 ** 3;
const formatGb = (bytes: number) => {
  const gb = bytes / GB;
  return gb >= 10 || Number.isInteger(gb) ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
};

/**
 * The org's storage: how much of its quota its drives use, and (for the Owner) extra storage
 * blocks on the Business subscription. Owner and Admins read it; only the Owner changes it.
 */
export function OrgStorageCard({ orgId, role }: { orgId: string; role: OrgRole | undefined }) {
  const { mutate } = useSWRConfig();
  const storage = useOrgAdminRead<{ storage: OrgStorage }>(orgReadKeys.storage(orgId), role).data?.storage;
  const [open, setOpen] = useState(false);
  const isOwner = orgRoleAtLeast(role, 'OWNER');
  if (!storage) return null;

  const percent = storage.quotaBytes > 0 ? Math.min(100, (storage.usedBytes / storage.quotaBytes) * 100) : 0;
  const extraBytes = storage.entitledBlocks * storage.blockBytes;

  const change = async (blocks: number) => {
    try {
      const result = await setOrgStorageBlocks(orgId, blocks);
      toast.success(result.charged ? 'Storage added' : 'Storage updated');
      void mutate((k) => isOrgKey(orgId, k));
    } catch (error) {
      throw new Error(orgErrorMessage(error, 'The storage change could not be completed.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        <CardDescription>
          Files in the organization&apos;s drives count against its storage.
          {extraBytes > 0 && ` Includes ${formatGb(extraBytes)} of extra storage.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={percent} aria-label="Storage in use" />
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>{formatGb(storage.usedBytes)} used</span>
          <span className="tabular-nums">{formatGb(storage.quotaBytes)}</span>
        </div>
        {storage.graceUntil && (
          <p className="text-xs text-muted-foreground">
            Extra storage drops to {formatGb(storage.blocks * storage.blockBytes)} on {new Date(storage.graceUntil).toLocaleDateString()}.
          </p>
        )}
        {storage.available && isOwner && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {storage.blocks > 0 ? 'Change storage' : 'Add storage'}
          </Button>
        )}
        {storage.available && !isOwner && (
          <p className="text-xs text-muted-foreground">Only the Owner can add storage.</p>
        )}
        {storage.unavailableReason === 'gifted' && (
          <p className="text-xs text-muted-foreground">Contact support to add storage to a gifted plan.</p>
        )}
      </CardContent>
      {storage.available && isOwner && (
        <StorageAddonDialog
          open={open}
          onOpenChange={setOpen}
          addon={storage}
          baseQuotaBytes={storage.quotaBytes - extraBytes}
          payerLabel="The organization's"
          onSubmit={change}
        />
      )}
    </Card>
  );
}
