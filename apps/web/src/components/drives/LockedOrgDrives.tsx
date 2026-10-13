'use client';

import useSWR from 'swr';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchJSON } from '@/lib/auth/auth-fetch';
import { useOrgReauthStore } from '@/stores/useOrgReauthStore';
import type { LockedDrive } from '@/components/auth/OrgReauthenticationPrompt';

/**
 * D-OW-45: org drives this sign-in is locked out of by an org's sign-in policy. GET /api/drives leaves them out; they
 * are shown here as "locked — sign in again" rather than vanishing, and the button opens the re-authentication prompt.
 */
export function LockedOrgDrives() {
  const { data } = useSWR<{ locked: LockedDrive[] }>('/api/drives/locked', (url: string) => fetchJSON<{ locked: LockedDrive[] }>(url));
  const report = useOrgReauthStore((s) => s.report);
  const locked = data?.locked ?? [];
  if (locked.length === 0) return null;

  return (
    <section className="mb-8" aria-label="Locked drives">
      <h2 className="text-xs uppercase tracking-widest text-muted-foreground/60 mb-3 px-1">Locked</h2>
      <ul className="overflow-hidden rounded-lg border bg-card">
        {locked.map((d) => (
          <li key={d.driveId} className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0">
            <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{d.driveName}</span>
              <span className="text-muted-foreground"> · {d.orgName ?? 'Organization'}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {d.code === 'org_strong_sign_in_required' ? 'Locked — use your passkey' : 'Locked — sign in again'}
            </span>
            <Button size="sm" variant="outline" onClick={() => report({ code: d.code, orgId: d.orgId })}>
              Unlock
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
