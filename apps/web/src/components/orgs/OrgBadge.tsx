import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils/index';

/**
 * The canvas badge tones (b-owner, b-admin, b-guest, b-open, b-restricted, b-private, b-pending,
 * b-out, b-live), on semantic tokens only so they hold in light and dark.
 */
export type OrgBadgeTone = 'owner' | 'admin' | 'member' | 'guest' | 'open' | 'restricted' | 'private' | 'pending' | 'outline' | 'live' | 'danger';

const TONES: Record<OrgBadgeTone, string> = {
  owner: 'border-transparent bg-primary-soft text-primary',
  admin: 'border-transparent bg-info/15 text-info',
  member: 'border-transparent bg-muted text-foreground',
  guest: 'border-transparent bg-warning/20 text-foreground',
  open: 'border-transparent bg-success/15 text-success',
  restricted: 'border-transparent bg-warning/20 text-foreground',
  private: 'border-transparent bg-muted text-foreground',
  pending: 'border-dashed bg-muted text-muted-foreground',
  outline: 'bg-transparent text-foreground',
  live: 'border-transparent bg-success/15 text-success',
  danger: 'border-transparent bg-destructive/10 text-destructive',
};

export function OrgBadge({ tone, className, children }: { tone: OrgBadgeTone; className?: string; children: React.ReactNode }) {
  return (
    <Badge variant="outline" className={cn(TONES[tone], className)}>
      {children}
    </Badge>
  );
}

const ROLE_LABEL = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' } as const;
const ROLE_TONE = { OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member' } as const;

export function OrgRoleBadge({ role }: { role: 'OWNER' | 'ADMIN' | 'MEMBER' }) {
  return <OrgBadge tone={ROLE_TONE[role]}>{ROLE_LABEL[role]}</OrgBadge>;
}
