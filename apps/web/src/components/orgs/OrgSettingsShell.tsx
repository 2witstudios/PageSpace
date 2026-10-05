'use client';

import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';
import type { OrgBillingNotice } from '@pagespace/lib/organizations/status-core';
import { useOrg, useOrgRealtime } from '@/hooks/useOrgs';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { orgIsLapsed } from '@/lib/orgs/org-lapse';
import type { OrgDetail, OrgRole } from '@/lib/orgs/org-api';
import { OrgPageContainer, OrgPageHeader } from './OrgPageHeader';
import { OrgBillingBanner } from './OrgBillingBanner';

export interface OrgSettingsContext {
  orgId: string;
  org: OrgDetail;
  orgName: string;
  role: OrgRole;
  /** SEAT-9: the org is unpaid; restricting works, loosening and spending are paused (D-OW-33). */
  lapsed: boolean;
  notice: OrgBillingNotice | undefined;
  refresh: () => void;
}

/**
 * Every org settings page below the hub: loads the org, keeps it live (org:changed), shows the lapse
 * banner, and refuses a plain Member (UI-11: a Member sees no org settings; the routes refuse too).
 */
export function OrgSettingsShell({ title, description, wide = true, minRole = 'ADMIN', children }: {
  title: string;
  description: (orgName: string) => React.ReactNode;
  wide?: boolean;
  minRole?: OrgRole;
  children: (ctx: OrgSettingsContext) => React.ReactNode;
}) {
  const params = useParams();
  const orgId = params.orgId as string;
  const { org, isLoading, error, mutate } = useOrg(orgId);
  useOrgRealtime(orgId);
  const back = { backHref: `/orgs/${orgId}/settings`, backLabel: 'Back to Organization Settings' };

  if (isLoading) {
    return (
      <OrgPageContainer wide={wide}>
        <Skeleton className="mb-2 h-8 w-48" />
        <Skeleton className="mb-8 h-4 w-80" />
        <Skeleton className="h-72 w-full" />
      </OrgPageContainer>
    );
  }
  if (!org) {
    return (
      <OrgPageContainer wide={wide}>
        <OrgPageHeader backHref="/dashboard" backLabel="Back to Dashboard" title={title} />
        <p className="text-muted-foreground">{orgErrorMessage(error, 'This organization could not be loaded.')}</p>
      </OrgPageContainer>
    );
  }
  const orgName = org.organization.name;
  const role = org.viewer.role;
  if (!orgRoleAtLeast(role, minRole)) {
    return (
      <OrgPageContainer wide={wide}>
        <OrgPageHeader {...back} title={title} />
        <p className="text-muted-foreground">Only the Owner or an Admin of {orgName} can see this page.</p>
      </OrgPageContainer>
    );
  }
  return (
    <OrgPageContainer wide={wide}>
      <OrgPageHeader {...back} title={title} description={description(orgName)} />
      <OrgBillingBanner orgId={orgId} orgName={orgName} notice={org.billingNotice} onReactivated={() => void mutate()} />
      {children({ orgId, org, orgName, role, lapsed: orgIsLapsed(org.billingNotice), notice: org.billingNotice, refresh: () => void mutate() })}
    </OrgPageContainer>
  );
}

/** The canvas "Paused while unpaid" hint under a control a lapsed org cannot loosen. */
export function PausedWhileUnpaid({ children = 'Paused while unpaid. Reactivate to change.' }: { children?: React.ReactNode }) {
  return <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">{children}</span>;
}
