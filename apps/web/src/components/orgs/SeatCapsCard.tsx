'use client';

import { useEffect, useState } from 'react';
import { Info, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatCreditCount } from '@pagespace/lib/billing/money-model';
import { DEFAULT_CONSUMER_CAPS } from '@pagespace/lib/billing/wallet-core';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEditingStore } from '@/stores/useEditingStore';
import { clearOrgSeatCap, setOrgSeatCap, type OrgMember, type OrgSeatCapView } from '@/lib/orgs/org-api';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { parseCreditsInput } from '@/lib/orgs/org-members';
import { seatCapChangeAllowed } from '@/lib/orgs/org-lapse';
import { OrgRoleBadge } from './OrgBadge';
import { PausedWhileUnpaid } from './OrgSettingsShell';

const EDITING_ID = 'org-seat-caps';
const toCredits = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : formatCreditCount(cents));

/**
 * A member's caps on their seat (WAL-7, canvas Members "Seat caps"): daily and monthly, in credits.
 * An empty monthly cap means the seat allowance, never unlimited (WAL-2). While the org is lapsed a
 * cap can be lowered or added but not raised or removed (D-OW-33).
 */
export function SeatCapsCard({ orgId, member, seat, seatAllowanceCents, lapsed, onClose, onSaved }: {
  orgId: string;
  member: OrgMember;
  seat: OrgSeatCapView | undefined;
  seatAllowanceCents: number;
  lapsed: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [daily, setDaily] = useState(toCredits(seat?.dailyCapCents));
  const [monthly, setMonthly] = useState(toCredits(seat?.monthlyCapCents));
  const [saving, setSaving] = useState(false);
  const name = member.name || member.email;

  useEffect(() => {
    setDaily(toCredits(seat?.dailyCapCents));
    setMonthly(toCredits(seat?.monthlyCapCents));
  }, [member.userId, seat?.dailyCapCents, seat?.monthlyCapCents]);

  useEffect(() => {
    useEditingStore.getState().startEditing(EDITING_ID, 'form', { componentName: 'SeatCapsCard' });
    return () => useEditingStore.getState().endEditing(EDITING_ID);
  }, []);

  const parsedDaily = parseCreditsInput(daily);
  const parsedMonthly = parseCreditsInput(monthly);
  const valid = parsedDaily.ok && parsedMonthly.ok;
  const current = { dailyCapCents: seat?.dailyCapCents ?? null, monthlyLimitCents: seat?.monthlyLimitCents ?? seatAllowanceCents };
  const next = { dailyCapCents: parsedDaily.ok ? parsedDaily.cents : null, monthlyCapCents: parsedMonthly.ok ? parsedMonthly.cents : null };
  // No caps yet and nothing typed: turning caps on takes the route's defaults (WAL-7, D-OW-31).
  const turningOnDefaults = seat?.dailyCapCents == null && seat?.monthlyCapCents == null && daily.trim() === '' && monthly.trim() === '';
  const written = turningOnDefaults
    ? { dailyCapCents: DEFAULT_CONSUMER_CAPS.dailyCents, monthlyCapCents: DEFAULT_CONSUMER_CAPS.monthlyCents }
    : next;
  const saveAllowed = valid && seatCapChangeAllowed(lapsed, current, written, seatAllowanceCents);
  const removeAllowed = seatCapChangeAllowed(lapsed, current, { dailyCapCents: null, monthlyCapCents: null }, seatAllowanceCents);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setSaving(true);
    try {
      await fn();
      toast.success(success);
      onSaved();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The caps could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Seat caps · {name}</CardTitle>
          <div className="flex items-center gap-2">
            <OrgRoleBadge role={member.role} />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close seat caps">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <CardDescription>Limits on what {name} can spend from their seat allowance. Only the Owner and Admins can change them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="seat-cap-daily">Daily cap</Label>
            <Input id="seat-cap-daily" inputMode="numeric" placeholder="No daily cap" value={daily} onChange={(e) => setDaily(e.target.value)} />
            <p className="text-xs text-muted-foreground">{parsedDaily.ok ? 'Credits. Leave empty for no daily cap.' : 'Enter a whole number of credits.'}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="seat-cap-monthly">Monthly cap</Label>
            <Input id="seat-cap-monthly" inputMode="numeric" placeholder="No monthly cap" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              {parsedMonthly.ok
                ? `On a seat, no monthly cap means the seat allowance: ${formatCreditCount(seatAllowanceCents)} credits a month here. It is never unlimited.`
                : 'Enter a whole number of credits.'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {seat ? `${formatCreditCount(seat.monthlyRemainingCents)} credits left this month` : ''}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={saving || !removeAllowed} onClick={() => void run(() => clearOrgSeatCap(orgId, member.userId), `Caps removed for ${name}`)}>
              Remove caps
            </Button>
            <Button size="sm" disabled={saving || !saveAllowed} onClick={() => void run(() => setOrgSeatCap(orgId, member.userId, turningOnDefaults ? {} : next), `Caps saved for ${name}`)}>
              {turningOnDefaults ? 'Turn on default caps' : 'Save'}
            </Button>
          </div>
        </div>
        {lapsed && valid && !saveAllowed ? <PausedWhileUnpaid>Lowering or adding a cap works. Raising or removing one is paused until the organization is reactivated.</PausedWhileUnpaid> : null}
        <div className="flex gap-2.5 rounded-lg bg-muted p-3 text-[13px] leading-[18px]">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span>{`Turning caps on without values sets ${formatCreditCount(DEFAULT_CONSUMER_CAPS.dailyCents ?? 0)} credits a day and ${formatCreditCount(DEFAULT_CONSUMER_CAPS.monthlyCents ?? 0)} credits a month. The Owner and Admins get an in-app alert when a member reaches 80% and 100% of a cap.`}</span>
        </div>
      </CardContent>
    </Card>
  );
}
