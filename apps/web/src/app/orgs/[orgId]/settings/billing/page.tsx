'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { Folder } from 'lucide-react';
import { toast } from 'sonner';
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';
import { formatCreditCount } from '@pagespace/lib/billing/money-model';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import { useOrgAdminRead, useOrgSeats } from '@/hooks/useOrgs';
import { OrgBadge } from '@/components/orgs/OrgBadge';
import { goToOrgBillingPortal } from '@/components/orgs/OrgBillingBanner';
import { OrgSettingsShell, type OrgSettingsContext } from '@/components/orgs/OrgSettingsShell';
import { isOrgKey, orgReadKeys, setOrgSeatAutoAdd, type OrgPoolSplit } from '@/lib/orgs/org-api';
import { invoiceLine, planFigures, poolFigures, seatFigures, type OrgInvoice } from '@/lib/orgs/org-billing';
import { orgErrorCode, orgErrorMessage } from '@/lib/orgs/org-error-copy';

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-background p-4">
      <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
      <span className="text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}

const STATUS_BADGE = {
  reactivate: { tone: 'danger', label: 'Lapsed' },
  read_only: { tone: 'danger', label: 'Lapsed' },
  payment_failed: { tone: 'restricted', label: 'Payment failed' },
  trial: { tone: 'pending', label: 'Trial' },
} as const;

function BillingBody({ orgId, orgName, role, notice }: OrgSettingsContext) {
  const { mutate } = useSWRConfig();
  const seatsRead = useOrgSeats(orgId, role);
  const seats = seatsRead.data?.seats;
  const pool = useOrgAdminRead<OrgPoolSplit>(orgReadKeys.pool(orgId), role).data;
  const invoices = useOrgAdminRead<{ invoices: OrgInvoice[]; hasMore: boolean }>(orgReadKeys.invoices(orgId), role).data?.invoices;
  const [savingAuto, setSavingAuto] = useState(false);
  const isOwner = orgRoleAtLeast(role, 'OWNER');

  if (orgErrorCode(seatsRead.error) === 'billing_unavailable') {
    return <p className="text-muted-foreground">Billing is not available on this deployment.</p>;
  }
  if (!seats) return <p className="text-sm text-muted-foreground">Loading the plan…</p>;

  const plan = planFigures(seats);
  const seatLine = seatFigures(seats);
  const badge = notice ? STATUS_BADGE[notice.kind] : { tone: 'live' as const, label: seats.hasSubscription ? 'Active' : 'Not started' };
  const pf = pool?.walletId ? poolFigures(pool) : null;

  const toggleAuto = async (autoAdd: boolean) => {
    setSavingAuto(true);
    try {
      await setOrgSeatAutoAdd(orgId, autoAdd);
      toast.success(autoAdd ? 'Seats are added automatically' : 'Automatic seats are off');
      void mutate((k) => isOrgKey(orgId, k));
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The seat setting could not be changed.'));
    } finally {
      setSavingAuto(false);
    }
  };

  return (
    <>
      <div className="mb-4 grid grid-cols-1 items-start gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Business plan</CardTitle>
              <OrgBadge tone={badge.tone}>{badge.label}</OrgBadge>
            </div>
            <CardDescription>{plan.terms}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col">
              <span className="text-2xl font-semibold tabular-nums">
                {plan.price}
                <span className="text-sm font-medium text-muted-foreground"> / month</span>
              </span>
              <span className="text-xs text-muted-foreground">{plan.breakdown}</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => void goToOrgBillingPortal(orgId)}>
              Billing portal
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Seats</CardTitle>
            <CardDescription>
              Everyone in Members uses one seat. {seats.included} are included in Business; the rest are billed per seat. Guests and agents do not use seats.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={seatLine.percent} aria-label="Seats in use" />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>{seatLine.inUse}</span>
              <span className="tabular-nums">{seatLine.total}</span>
            </div>
            <div className="flex items-start gap-3">
              <Switch
                aria-label="Add seats automatically"
                checked={seats.autoAdd}
                disabled={!isOwner || savingAuto}
                onCheckedChange={(checked) => void toggleAuto(checked)}
              />
              <div className="flex flex-col">
                <span className="text-sm font-medium">Add seats automatically</span>
                <span className="text-xs text-muted-foreground">
                  When someone is invited and no seat is free, one is added and billed pro rata. Removing a member frees the seat at the end of the period.
                  {isOwner ? '' : ' Only the Owner can change this.'}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card id="pool" className="mb-4">
        <CardHeader>
          <CardTitle>Credits pool</CardTitle>
          <CardDescription>
            The org&rsquo;s balance. Nothing spends from it directly: it is allocated into a monthly allowance per seat and a wallet per org drive. Unspent allocations stay here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {pf && pool ? (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Stat {...pf.unallocated} />
                <Stat {...pf.seats} />
                <Stat {...pf.drives} />
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">Drive wallets</span>
                  <span className="text-xs text-muted-foreground">A drive&rsquo;s AI runs on its wallet first, then the caller&rsquo;s seat allowance.</span>
                </div>
                <div className="overflow-hidden rounded-lg border bg-card">
                  <div className="hidden items-center gap-4 bg-muted px-4 py-2 text-xs text-muted-foreground sm:flex">
                    <span className="flex-1">Drive</span>
                    <span className="w-[130px]">Monthly allocation</span>
                    <span className="w-[110px]">Spent</span>
                    <span className="w-[60px]" />
                  </div>
                  {pool.driveWallets.map((w) => (
                    <div key={w.walletId} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2.5 first:border-t-0">
                      <Folder className="h-4 w-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{w.driveName}</span>
                      <span className="w-[130px] tabular-nums">{formatCreditCount(w.allocationCents)} credits</span>
                      <span className="w-[110px] text-xs tabular-nums text-muted-foreground">{formatCreditCount(w.spentCents)} credits</span>
                      <span className="w-[60px]">
                        {w.status === 'over' ? <OrgBadge tone="restricted">Over</OrgBadge> : w.status === 'paused' ? <OrgBadge tone="pending">Paused</OrgBadge> : (
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/dashboard/${w.driveId}/settings`}>Edit</Link>
                          </Button>
                        )}
                      </span>
                    </div>
                  ))}
                  {pool.drivesWithoutWallet.length > 0 ? (
                    <div className="flex items-center gap-4 border-t px-4 py-2.5 first:border-t-0">
                      <span className="flex-1 text-xs text-muted-foreground">
                        {pool.drivesWithoutWallet.map((d) => d.name).join(', ')} · no wallet, seat allowances only
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{orgName} has no credits pool yet. The first payment funds it.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
          <CardDescription>
            Billing email, payment method and tax details are in the{' '}
            <button type="button" className="text-primary hover:underline" onClick={() => void goToOrgBillingPortal(orgId)}>billing portal</button>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(invoices ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            (invoices ?? []).map((inv, i) => {
              const line = invoiceLine(inv);
              return (
                <div key={inv.id} className={`flex flex-wrap items-center justify-between gap-3 py-2.5 ${i > 0 ? 'border-t' : ''}`}>
                  <span className="tabular-nums">{line.date}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{line.summary}</span>
                  <OrgBadge tone={line.tone}>{line.status}</OrgBadge>
                  {inv.invoicePdf ? (
                    <a className="text-[13px] text-primary hover:underline" href={inv.invoicePdf} target="_blank" rel="noopener noreferrer">PDF</a>
                  ) : inv.hostedInvoiceUrl ? (
                    <a className="text-[13px] text-primary hover:underline" href={inv.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">View</a>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default function OrgBillingPage() {
  const { showBilling } = useBillingVisibility();
  return (
    <OrgSettingsShell title="Plan & seats" description={(orgName) => `${orgName} is billed separately from your personal plan.`}>
      {(ctx) => (showBilling ? <BillingBody {...ctx} /> : <p className="text-muted-foreground">Billing is not available here.</p>)}
    </OrgSettingsShell>
  );
}
