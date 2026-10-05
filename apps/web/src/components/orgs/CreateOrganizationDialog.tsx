'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Folder, Home, Info, Loader2 } from 'lucide-react';
import { orgPlanQuote } from '@pagespace/lib/billing/org-plan-quote';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { StripeProvider } from '@/components/billing/StripeProvider';
import { useAuth } from '@/hooks/useAuth';
import { useDriveStore } from '@/hooks/useDrive';
import { useMyOrgs } from '@/hooks/useOrgs';
import { useEditingStore } from '@/stores/useEditingStore';
import { isBillingEnabled } from '@/lib/deployment-mode';
import { toast } from 'sonner';
import {
  createOrganization,
  fetchDriveMemberEmails,
  orgFetcher,
  orgKeys,
  startOrgSubscription,
  type OrgDetail,
} from '@/lib/orgs/org-api';
import { clearPendingSetup, loadPendingSetup, savePendingSetup } from '@/lib/orgs/pending-setup';
import { runOrgSetup } from '@/lib/orgs/run-org-setup';
import {
  createOrgPlanNote,
  createOrgSeatCount,
  firstPaymentLines,
  mergeInviteEmails,
  nextStepAfterCreate,
  orgReadyForSetup,
  parseInviteEmails,
} from '@/lib/orgs/create-org-flow';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { isValidOrgSlug, slugFromOrgName } from '@/lib/orgs/org-slug';
import { OrgPaymentForm } from './OrgPaymentForm';

const EDITING_ID = 'create-organization';
/** How long to wait for the Stripe webhook to activate the org before setting up anyway. */
const ACTIVATION_TIMEOUT_MS = 90_000;
const ACTIVATION_POLL_MS = 2_000;

type Step =
  | { step: 'details' }
  | { step: 'payment'; orgId: string; clientSecret: string; extraSeatQuantity: number }
  | { step: 'retry_payment'; orgId: string }
  | { step: 'activating'; orgId: string }
  | { step: 'setup'; orgId: string }
  | { step: 'done'; orgId: string; failures: string[] };

export interface CreateOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateOrganizationDialog({ open, onOpenChange }: CreateOrganizationDialogProps) {
  const router = useRouter();
  const { user } = useAuth();
  const selfEmail = user?.email ?? '';
  const { resolvedTheme } = useTheme();
  const drives = useDriveStore((s) => s.drives);
  const fetchDrives = useDriveStore((s) => s.fetchDrives);
  const { mutate: refreshMyOrgs } = useMyOrgs();

  const [state, setState] = useState<Step>({ step: 'details' });
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [invitesText, setInvitesText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  const billing = isBillingEnabled();
  const ownDrives = useMemo(() => drives.filter((d) => d.isOwned && !d.orgId && !d.isTrashed), [drives]);
  const parsed = parseInviteEmails(invitesText);
  const seats = createOrgSeatCount(parsed.valid, selfEmail);
  const note = createOrgPlanNote(orgPlanQuote(seats));
  const effectiveSlug = slugEdited ? slug : slugFromOrgName(name);

  // A form is being filled in: SWR revalidation and auth refresh must not interrupt it.
  useEffect(() => {
    if (!open) return;
    useEditingStore.getState().startEditing(EDITING_ID, 'form', { componentName: 'CreateOrganizationDialog' });
    return () => useEditingStore.getState().endEditing(EDITING_ID);
  }, [open]);

  useEffect(() => {
    if (open) void fetchDrives();
  }, [open, fetchDrives]);

  const reset = () => {
    setState({ step: 'details' });
    setName('');
    setSlug('');
    setSlugEdited(false);
    setSelected([]);
    setMemberCounts({});
    setInvitesText('');
    setError(null);
    setNames({});
  };

  const close = (next: boolean) => {
    // Once the org exists, closing goes to it rather than abandoning it: it resumes from the hub, where the
    // saved setup plan (drives, invitations) is offered once the org is paid (review P2-7).
    if (!next && state.step !== 'details' && state.step !== 'done') {
      if (loadPendingSetup(state.orgId)) {
        toast.info('Your chosen drives and invitations are saved. Finish setup from the organization page once it is paid.');
      }
      router.push(`/orgs/${state.orgId}/settings`);
    }
    if (!next) reset();
    onOpenChange(next);
  };

  const toggleDrive = async (driveId: string, checked: boolean) => {
    setSelected((prev) => (checked ? [...prev, driveId] : prev.filter((id) => id !== driveId)));
    if (!checked) return;
    try {
      const emails = await fetchDriveMemberEmails(driveId);
      setMemberCounts((prev) => ({ ...prev, [driveId]: emails.length }));
      setInvitesText((text) => mergeInviteEmails(text, emails, selfEmail));
    } catch {
      // The drive still moves; its people can be invited later from Members & seats.
    }
  };

  const submitDetails = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Give the organization a name.');
    if (!isValidOrgSlug(effectiveSlug)) return setError('Use 1-48 lowercase letters, digits or hyphens for the URL.');
    if (parsed.invalid.length > 0) return setError(`These are not email addresses: ${parsed.invalid.join(', ')}`);
    setSubmitting(true);
    try {
      const created = await createOrganization({ name: name.trim(), slug: effectiveSlug });
      const orgId = created.organization.id;
      const driveNames = Object.fromEntries(ownDrives.map((d) => [d.id, d.name]));
      setNames(driveNames);
      savePendingSetup(orgId, { driveIds: selected, invites: parsed.valid, selfEmail, driveNames });
      void refreshMyOrgs();
      const next = nextStepAfterCreate(created.billing);
      if (next.step === 'payment') {
        const extra = created.billing.state === 'payment_required' ? created.billing.subscription.extraSeatQuantity : 0;
        setState({ step: 'payment', orgId, clientSecret: next.clientSecret, extraSeatQuantity: extra });
      } else if (next.step === 'retry_payment') {
        setState({ step: 'retry_payment', orgId });
      } else {
        setState({ step: 'setup', orgId });
      }
    } catch (err) {
      setError(orgErrorMessage(err, 'The organization could not be created. Try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  const retryPayment = async (orgId: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await startOrgSubscription(orgId);
      if (res.payment.kind === 'confirm_payment') {
        setState({ step: 'payment', orgId, clientSecret: res.payment.clientSecret, extraSeatQuantity: res.subscription.extraSeatQuantity });
      } else {
        setState({ step: 'activating', orgId });
      }
    } catch (err) {
      setError(orgErrorMessage(err, 'We could not reach the payment provider. Try again in a moment.'));
    } finally {
      setSubmitting(false);
    }
  };

  // Paid: wait for the webhook to activate the org, then set it up. Drives and invitations are
  // refused while the org is lapsed, so setup waits; past the timeout it runs and reports what failed.
  useEffect(() => {
    if (state.step !== 'activating') return;
    const { orgId } = state;
    let cancelled = false;
    const started = Date.now();
    const poll = async () => {
      while (!cancelled) {
        try {
          const detail = await orgFetcher<OrgDetail>(orgKeys.detail(orgId));
          if (orgReadyForSetup(detail.billingNotice)) break;
        } catch {
          // keep waiting; the timeout below bounds it
        }
        if (Date.now() - started > ACTIVATION_TIMEOUT_MS) break;
        await new Promise((r) => setTimeout(r, ACTIVATION_POLL_MS));
      }
      if (!cancelled) setState({ step: 'setup', orgId });
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [state]);

  useEffect(() => {
    if (state.step !== 'setup') return;
    const { orgId } = state;
    let cancelled = false;
    const run = async () => {
      const plan = loadPendingSetup(orgId) ?? { driveIds: selected, invites: parsed.valid, selfEmail, driveNames: names };
      const failures = await runOrgSetup(orgId, plan, () => cancelled);
      if (!cancelled) clearPendingSetup(orgId);
      if (cancelled) return;
      void fetchDrives(false, true);
      void refreshMyOrgs();
      if (failures.length === 0) {
        reset();
        onOpenChange(false);
        router.push(`/orgs/${orgId}/settings`);
      } else {
        setState({ step: 'done', orgId, failures });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // The plan is fixed once setup starts; re-running on unrelated renders would repeat writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step]);

  const stripeOptions = useMemo(
    () =>
      state.step === 'payment'
        ? {
            clientSecret: state.clientSecret,
            appearance: { theme: (resolvedTheme === 'dark' ? 'night' : 'stripe') as 'night' | 'stripe' },
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.step === 'payment' ? state.clientSecret : null, resolvedTheme],
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        {state.step === 'details' ? (
          <form onSubmit={submitDetails} className="space-y-5">
            <DialogHeader>
              <DialogTitle>Create an organization</DialogTitle>
              <DialogDescription>
                An organization owns drives, pays for them, and sets the rules inside them. Your Home drive stays personal.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label htmlFor="org-name">Name</Label>
              <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind Labs" maxLength={100} autoFocus />
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>URL name</span>
                <Input
                  aria-label="URL name"
                  value={effectiveSlug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setSlug(e.target.value.toLowerCase());
                  }}
                  className="h-7 max-w-[220px] text-xs"
                  maxLength={48}
                />
                <span>you can change this later</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Move drives you own into {name.trim() || 'the organization'}</Label>
              <p className="text-xs text-muted-foreground">
                They become org-owned: the organization pays for them and org policies apply. Members keep their roles.
              </p>
              <div className="overflow-hidden rounded-lg border bg-card">
                {ownDrives.length === 0 ? (
                  <div className="px-3.5 py-2.5 text-sm text-muted-foreground">You do not own any drives yet.</div>
                ) : (
                  ownDrives.map((drive, index) => {
                    const isHome = drive.kind === 'HOME';
                    const count = memberCounts[drive.id];
                    return (
                      <label
                        key={drive.id}
                        className={`flex items-center gap-3 px-3.5 py-2.5 ${index > 0 ? 'border-t' : ''} ${isHome ? 'opacity-55' : 'cursor-pointer'}`}
                      >
                        <Checkbox
                          checked={selected.includes(drive.id)}
                          disabled={isHome}
                          onCheckedChange={(checked) => void toggleDrive(drive.id, checked === true)}
                          aria-label={`Move ${drive.name}`}
                        />
                        {isHome ? <Home className="h-4 w-4 text-muted-foreground" /> : <Folder className="h-4 w-4 text-muted-foreground" />}
                        <span className="flex-1 truncate">{drive.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {isHome ? 'stays personal' : count === undefined ? '' : count <= 1 ? 'just you' : `${count} members`}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="org-invites">Invite people</Label>
              <Textarea
                id="org-invites"
                value={invitesText}
                onChange={(e) => setInvitesText(e.target.value)}
                placeholder="priya@northwind.com, dana@northwind.com…"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                People in the drives you move are added here. Each person you invite uses a seat.
              </p>
            </div>

            {billing ? (
              <div className="flex gap-2.5 rounded-lg bg-muted p-3 text-[13px] leading-[18px]">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span>
                  <b>{note.headline}</b> {note.body}
                </span>
              </div>
            ) : null}

            {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {billing ? 'Continue to payment' : 'Create organization'}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {state.step === 'payment' ? (
          <div className="space-y-5">
            <DialogHeader>
              <DialogTitle>Pay for {name.trim()}</DialogTitle>
              <DialogDescription>Step 2 of 2. The organization is ready once this payment goes through.</DialogDescription>
            </DialogHeader>
            <PaymentSummary extraSeatQuantity={state.extraSeatQuantity} />
            <StripeProvider options={stripeOptions}>
              <OrgPaymentForm
                orgId={state.orgId}
                submitLabel={`Pay ${firstPaymentLines(state.extraSeatQuantity).total} and create`}
                backLabel="Pay later"
                onBack={() => close(false)}
                onPaid={() => setState({ step: 'activating', orgId: state.orgId })}
              />
            </StripeProvider>
            <p className="text-xs text-muted-foreground">
              This payment funds the {name.trim()} credits pool, shared out as seat allowances and drive wallets.
            </p>
          </div>
        ) : null}

        {state.step === 'retry_payment' ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>Payment is not ready yet</DialogTitle>
              <DialogDescription>
                {name.trim()} was created, but we could not reach the payment provider to start its subscription.
              </DialogDescription>
            </DialogHeader>
            {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>Do this later</Button>
              <Button onClick={() => void retryPayment(state.orgId)} disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Try again
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {state.step === 'activating' || state.step === 'setup' ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center" role="status">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <div className="font-medium">{state.step === 'activating' ? 'Confirming the payment…' : `Setting up ${name.trim()}…`}</div>
            <p className="text-sm text-muted-foreground">
              {state.step === 'activating' ? 'This usually takes a few seconds.' : 'Moving drives and sending invitations.'}
            </p>
          </div>
        ) : null}

        {state.step === 'done' ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>{name.trim()} is ready, with a few things left</DialogTitle>
              <DialogDescription>These did not go through. You can finish them from the organization settings.</DialogDescription>
            </DialogHeader>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {state.failures.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <DialogFooter>
              <Button
                onClick={() => {
                  const orgId = state.orgId;
                  reset();
                  onOpenChange(false);
                  router.push(`/orgs/${orgId}/settings`);
                }}
              >
                Go to organization settings
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PaymentSummary({ extraSeatQuantity }: { extraSeatQuantity: number }) {
  const { lines, total } = firstPaymentLines(extraSeatQuantity);
  return (
    <div className="overflow-hidden rounded-lg border bg-card text-sm">
      {lines.map((line) => (
        <div key={line.label} className="flex items-center border-b px-3.5 py-2.5">
          <span className="flex-1">{line.label}</span>
          <span className="tabular-nums">{line.amount}</span>
        </div>
      ))}
      <div className="flex items-center px-3.5 py-2.5 font-semibold">
        <span className="flex-1">Due today, then monthly</span>
        <span className="tabular-nums">{total}</span>
      </div>
    </div>
  );
}
