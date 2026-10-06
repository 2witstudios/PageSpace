'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import { useMyOrgs, useOrg, useOrgHubCounts, useOrgRealtime, useOrgSeats } from '@/hooks/useOrgs';
import { OrgPageContainer, OrgPageHeader } from '@/components/orgs/OrgPageHeader';
import { OrgMark } from '@/components/orgs/OrgMark';
import { OrgBadge, OrgRoleBadge } from '@/components/orgs/OrgBadge';
import { LeaveOrgDialog } from '@/components/orgs/LeaveOrgDialog';
import { OrgBillingBanner } from '@/components/orgs/OrgBillingBanner';
import { PendingSetupCard } from '@/components/orgs/PendingSetupCard';
import { ORG_HUB_ICONS } from '@/components/orgs/org-hub-icons';
import { orgHubSections, type OrgHubRow } from '@/lib/orgs/org-hub';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { formatOrgShortDate } from '@/lib/orgs/org-format';
import { cn } from '@/lib/utils/index';
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';

function HubRow({ row, index, onAction }: { row: OrgHubRow; index: number; onAction: (action: 'leave') => void }) {
  const Icon = ORG_HUB_ICONS[row.icon];
  const body = (
    <div
      className={cn(
        'group flex items-center gap-4 px-4 py-3 text-left transition-colors',
        row.available ? 'hover:bg-accent hover:text-accent-foreground' : 'opacity-50',
        index > 0 && 'border-t',
        row.action === 'leave' && 'text-destructive',
      )}
    >
      <Icon className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{row.title}</div>
        <div className="truncate text-sm text-muted-foreground">{row.description}</div>
      </div>
      {row.badge ? <OrgBadge tone={row.icon === 'guests' || row.icon === 'automation' ? 'restricted' : 'outline'}>{row.badge}</OrgBadge> : null}
      {row.available ? (
        row.href ? <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" /> : null
      ) : (
        <span className="text-xs text-muted-foreground">Coming Soon</span>
      )}
    </div>
  );
  if (!row.available) return <div aria-disabled="true">{body}</div>;
  if (row.action) {
    return (
      <button type="button" className="block w-full" onClick={() => onAction(row.action as 'leave')}>
        {body}
      </button>
    );
  }
  return <Link href={row.href ?? '#'}>{body}</Link>;
}

export default function OrgSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const orgId = params.orgId as string;
  const { showBilling } = useBillingVisibility();
  const { org, isLoading, error, mutate: refreshOrg } = useOrg(orgId);
  const { mutate: refreshMyOrgs } = useMyOrgs();
  const role = org?.viewer.role;
  const hubCounts = useOrgHubCounts(orgId, role);
  const seats = useOrgSeats(orgId, role, showBilling).data?.seats;
  // SEAT-3: pending invitations come from the server's seat count wherever seats are loaded (one source).
  const counts = { ...hubCounts, pendingInvites: seats?.pendingInvites ?? hubCounts.pendingInvites };
  const [leaveOpen, setLeaveOpen] = useState(false);
  useOrgRealtime(orgId);

  if (isLoading) {
    return (
      <OrgPageContainer>
        <Skeleton className="mb-2 h-8 w-48" />
        <Skeleton className="mb-8 h-4 w-64" />
        <Skeleton className="h-64 w-full" />
      </OrgPageContainer>
    );
  }

  if (!org || !role) {
    return (
      <OrgPageContainer>
        <OrgPageHeader backHref="/dashboard" backLabel="Back to Dashboard" title="Organization Settings" />
        <p className="text-muted-foreground">{orgErrorMessage(error, 'This organization could not be loaded.')}</p>
      </OrgPageContainer>
    );
  }

  const { name, slug, avatarUrl } = org.organization;
  const renewal = formatOrgShortDate(seats?.currentPeriodEnd);
  const sections = orgHubSections({
    orgId,
    orgName: name,
    role,
    counts,
    billingEnabled: showBilling,
    renewalLabel: renewal ? `Renews ${renewal}` : undefined,
  });
  const planLine = showBilling && seats && orgRoleAtLeast(role, 'ADMIN') ? `Business plan · ${seats.members} of ${seats.purchased} seats` : null;

  return (
    <OrgPageContainer>
      <OrgPageHeader backHref="/dashboard" backLabel="Back to Dashboard" title="Organization Settings" description={`Configure ${name}`} />
      <div className="-mt-4 mb-8 flex items-center gap-3">
        <OrgMark name={name} avatarUrl={avatarUrl} size="lg" decorative />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="truncate text-base font-semibold">{name}</div>
          <div className="truncate text-xs text-muted-foreground">{[slug, planLine].filter(Boolean).join(' · ')}</div>
        </div>
        <span className="ml-auto">
          <OrgRoleBadge role={role} />
        </span>
      </div>

      <OrgBillingBanner orgId={orgId} orgName={name} notice={org.billingNotice} onReactivated={() => void refreshOrg()} />
      {orgRoleAtLeast(role, 'ADMIN') ? <PendingSetupCard orgId={orgId} orgName={name} notice={org.billingNotice} onDone={() => void refreshOrg()} /> : null}

      <div className="space-y-8">
        {sections.map((section) => (
          <section key={section.title}>
            <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">{section.title}</h2>
            <div className="overflow-hidden rounded-lg border bg-card">
              {section.rows.map((row, index) => (
                <HubRow key={row.title} row={row} index={index} onAction={() => setLeaveOpen(true)} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <LeaveOrgDialog
        orgId={orgId}
        orgName={name}
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        onLeft={() => {
          void refreshMyOrgs();
          router.push('/dashboard');
        }}
      />
    </OrgPageContainer>
  );
}
