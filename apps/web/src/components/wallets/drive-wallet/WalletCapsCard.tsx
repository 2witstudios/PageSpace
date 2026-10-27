'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Bell } from 'lucide-react';
import { parseCreditInput } from '@pagespace/lib/billing/wallet-surface';
import { DEFAULT_CONSUMER_CAPS } from '@pagespace/lib/billing/wallet-core';
import { formatCreditCount } from '@pagespace/lib/billing/money-model';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { del, fetchWithAuth, put } from '@/lib/auth/auth-fetch';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { useEditingStore } from '@/stores/useEditingStore';

/** `GET /api/drives/[driveId]/wallet/caps` (WAL-7). */
export interface ConsumerCapView {
  userId: string;
  displayName: string;
  dailyCapCents: number | null;
  monthlyCapCents: number | null;
  dailyCapCredits: string | null;
  monthlyCapCredits: string | null;
}

const fetcher = async (url: string): Promise<{ walletId: string; caps: ConsumerCapView[] }> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

interface WalletCapsCardProps {
  driveId: string;
  orgName: string | null;
  /** Everyone who can spend here, by user id (the drive's members). */
  memberNames: Record<string, string>;
  editable: boolean;
  /** Bumped by the page when `wallet:changed` reports a caps change, to refetch. */
  revision: number;
}

/**
 * Member caps (Spec WAL-7; canvas v9 DriveWallet "Member caps"): the daily and monthly limit one
 * person can spend from this wallet. Org Owner/Admins set them on an org drive, the wallet's
 * owner on a personal drive; an org drive's lead sees them read-only. Enabling a cap without
 * values takes the defaults (D-OW-31, DEFAULT_CONSUMER_CAPS); "No cap" is unlimited here.
 */
/** The defaults a cap turned on without values takes (D-OW-31), from the one constant (MON-1: no copy states a figure). */
const DEFAULT_DAILY_CREDITS = formatCreditCount(DEFAULT_CONSUMER_CAPS.dailyCents ?? 0);
const DEFAULT_MONTHLY_CREDITS = formatCreditCount(DEFAULT_CONSUMER_CAPS.monthlyCents ?? 0);

export function WalletCapsCard({ driveId, orgName, memberNames, editable, revision }: WalletCapsCardProps) {
  const { data, mutate } = useSWR(`/api/drives/${encodeURIComponent(driveId)}/wallet/caps`, fetcher, { revalidateOnFocus: false });
  const [editing, setEditing] = useState<{ userId: string; name: string } | null>(null);

  useEffect(() => {
    if (revision > 0) void mutate();
  }, [revision, mutate]);

  const caps = new Map((data?.caps ?? []).map((c) => [c.userId, c]));
  const people = [...new Set([...Object.keys(memberNames), ...caps.keys()])]
    .map((userId) => ({ userId, name: memberNames[userId] ?? caps.get(userId)?.displayName ?? 'Unknown member', cap: caps.get(userId) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Card data-testid="wallet-caps-card">
      <CardHeader>
        <CardTitle>Member caps</CardTitle>
        <CardDescription>
          Limit what one person can spend from this wallet. {orgName ? `On an org drive the ${orgName} Owner and Admins set caps.` : "On a personal drive, the wallet's owner sets them."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Member</th>
                <th className="px-3 py-2 font-normal">Daily cap</th>
                <th className="px-3 py-2 font-normal">Monthly cap</th>
                {editable && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId} className="border-t">
                  <td className="px-3 py-2">{p.name}</td>
                  <td className="px-3 py-2 tabular-nums">{p.cap?.dailyCapCredits ? `${p.cap.dailyCapCredits} credits` : <span className="text-muted-foreground">No cap</span>}</td>
                  <td className="px-3 py-2 tabular-nums">{p.cap?.monthlyCapCredits ? `${p.cap.monthlyCapCredits} credits` : <span className="text-muted-foreground">No cap</span>}</td>
                  {editable && (
                    <td className="px-3 py-2 text-right">
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ userId: p.userId, name: p.name })}>
                        {p.cap ? 'Edit' : 'Set cap'}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Turning a cap on without values sets {DEFAULT_DAILY_CREDITS} credits a day and {DEFAULT_MONTHLY_CREDITS} credits a month. No cap means no limit inside this wallet. A person who reaches a cap is offered their other sources.
        </p>
        <div className="flex gap-2.5 rounded-lg bg-muted px-3.5 py-3 text-xs">
          <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>
            Whoever funds this wallet gets an in-app alert when a member reaches 80% and 100% of a cap.{' '}
            {orgName ? `Here that is the ${orgName} Owner and Admins.` : "Here that is the drive's owner."}
          </span>
        </div>
      </CardContent>
      {editing && (
        <CapEditDialog
          driveId={driveId}
          person={editing}
          cap={caps.get(editing.userId) ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await mutate();
          }}
        />
      )}
    </Card>
  );
}

function CapEditDialog({ driveId, person, cap, onClose, onSaved }: {
  driveId: string;
  person: { userId: string; name: string };
  cap: ConsumerCapView | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editingId = `wallet-cap-${driveId}-${person.userId}`;
  const startEditing = useEditingStore((s) => s.startEditing);
  const endEditing = useEditingStore((s) => s.endEditing);
  const [daily, setDaily] = useState(cap?.dailyCapCredits ?? '');
  const [monthly, setMonthly] = useState(cap?.monthlyCapCredits ?? '');
  const [noDaily, setNoDaily] = useState(cap !== null && cap.dailyCapCents === null);
  const [noMonthly, setNoMonthly] = useState(cap !== null && cap.monthlyCapCents === null);
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    startEditing(editingId, 'form', { componentName: 'CapEditDialog' });
    return () => endEditing(editingId);
  }, [editingId, startEditing, endEditing]);

  const windowValue = (text: string, none: boolean): number | null | undefined | 'invalid' => {
    if (none) return null;
    if (text.trim() === '') return undefined;
    const parsed = parseCreditInput(text);
    return parsed.ok ? parsed.cents : 'invalid';
  };

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    try {
      await action();
      await onSaved();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The cap could not be saved. Try again.'));
    } finally {
      setPending(false);
    }
  };

  const save = () => {
    const d = windowValue(daily, noDaily);
    const m = windowValue(monthly, noMonthly);
    if (d === 'invalid' || m === 'invalid') {
      setInvalid(true);
      return;
    }
    // Omitted windows keep their value, or take the default when the cap is first turned on.
    const body = { ...(d !== undefined ? { dailyCapCents: d } : {}), ...(m !== undefined ? { monthlyCapCents: m } : {}) };
    void run(() => put(`/api/drives/${driveId}/wallet/caps/${person.userId}`, body));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Caps for {person.name}</DialogTitle>
          <DialogDescription>Leave a field empty to keep it (or take the default when turning caps on). UTC days and months.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {([
            ['daily', 'Daily cap', daily, setDaily, noDaily, setNoDaily],
            ['monthly', 'Monthly cap', monthly, setMonthly, noMonthly, setNoMonthly],
          ] as const).map(([key, label, value, setValue, none, setNone]) => (
            <div key={key} className="flex flex-col gap-1.5">
              <Label htmlFor={`cap-${key}`}>{label}</Label>
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Input
                    id={`cap-${key}`}
                    inputMode="numeric"
                    value={none ? '' : value}
                    disabled={none || pending}
                    placeholder={key === 'daily' ? DEFAULT_DAILY_CREDITS : DEFAULT_MONTHLY_CREDITS}
                    onChange={(e) => {
                      setInvalid(false);
                      setValue(e.target.value);
                    }}
                    className="pr-16 tabular-nums"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">credits</span>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={none} onCheckedChange={(v) => setNone(v === true)} disabled={pending} />
                  No cap
                </label>
              </div>
            </div>
          ))}
          {invalid && <p className="text-xs text-destructive">Enter whole numbers of credits.</p>}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {cap ? (
            <Button variant="ghost" className="text-destructive" disabled={pending} onClick={() => void run(() => del(`/api/drives/${driveId}/wallet/caps/${person.userId}`))}>
              Remove caps
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
            <Button disabled={pending} onClick={save}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
