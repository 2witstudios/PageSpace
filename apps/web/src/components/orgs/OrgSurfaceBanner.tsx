'use client';

import { useMyOrganizations } from '@/hooks/useMyOrganizations';
import { useOrg } from '@/hooks/useOrgs';
import { useSurfaceOrgId } from '@/hooks/useSurfaceOrgId';
import { OrgBillingBanner } from './OrgBillingBanner';

/**
 * SEAT-9: the ONE placement of the lapse banner, in the app shell above every page. On an org
 * surface (any /orgs/[orgId] page, any page of an open org drive) it shows what GET
 * /api/orgs/[orgId] says this viewer sees: reactivate for the Owner and Admins, the read-only
 * notice for a Member, nothing for a paid org or where billing is off. A guest on an org drive is
 * not an org member, so the org is never asked for (useSurfaceOrgId).
 */
export function OrgSurfaceBanner() {
  const orgId = useSurfaceOrgId();
  const { org, mutate } = useOrg(orgId);
  const { refresh: refreshMyOrgs } = useMyOrganizations();

  if (!orgId || !org?.billingNotice) return null;
  return (
    <OrgBillingBanner
      orgId={orgId}
      orgName={org.organization.name}
      notice={org.billingNotice}
      onReactivated={() => {
        void mutate();
        void refreshMyOrgs();
      }}
      className="mx-4 mt-3 shrink-0 sm:mx-6"
    />
  );
}
