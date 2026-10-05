'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { Skeleton } from '@/components/ui/skeleton';
import { useMyOrgs, useOrgRealtime } from '@/hooks/useOrgs';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import { isBillingEnabled } from '@/lib/deployment-mode';
import { CreateOrganizationDialog } from './CreateOrganizationDialog';
import { OrgMark } from './OrgMark';
import { OrgRoleBadge } from './OrgBadge';

/**
 * Account Settings › Organizations (UI-2): every org I belong to, plus Create. Nothing renders while
 * orgs are dark. Creating needs a card (D-OW-30), so where purchases are hidden (iOS) Create is too.
 */
export function AccountOrganizationsSection() {
  const { orgs, isLoading } = useMyOrgs();
  const { showBilling } = useBillingVisibility();
  const [creating, setCreating] = useState(false);
  useOrgRealtime();

  if (!ORGS_ENABLED) return null;
  const canCreate = !isBillingEnabled() || showBilling;

  return (
    <div>
      <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">Organizations</h2>
      <div className="overflow-hidden rounded-lg border bg-card">
        {isLoading ? (
          <div className="px-4 py-3">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          (orgs ?? []).map((org, index) => (
            <Link key={org.id} href={`/orgs/${org.id}/settings`}>
              <div className={`group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent hover:text-accent-foreground ${index > 0 ? 'border-t' : ''}`}>
                <OrgMark name={org.name} avatarUrl={org.avatarUrl} decorative />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{org.name}</div>
                  <div className="truncate text-sm text-muted-foreground group-hover:text-accent-foreground">{org.slug}</div>
                </div>
                <OrgRoleBadge role={org.role} />
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-accent-foreground" />
              </div>
            </Link>
          ))
        )}
        {canCreate ? (
          <button type="button" className="block w-full text-left" onClick={() => setCreating(true)}>
            <div className={`group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent hover:text-accent-foreground ${(orgs?.length ?? 0) > 0 || isLoading ? 'border-t' : ''}`}>
              <Plus className="h-5 w-5 text-muted-foreground group-hover:text-accent-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">Create organization</div>
                <div className="truncate text-sm text-muted-foreground group-hover:text-accent-foreground">
                  Own drives together, pay for them once, and set the rules inside them
                </div>
              </div>
            </div>
          </button>
        ) : null}
      </div>
      {canCreate ? <CreateOrganizationDialog open={creating} onOpenChange={setCreating} /> : null}
    </div>
  );
}
