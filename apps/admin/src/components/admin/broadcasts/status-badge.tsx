import { Badge, type badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';
import type { BroadcastStatus } from './types';

type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];

const STATUS_LABELS: Record<BroadcastStatus, string> = {
  draft: 'Draft',
  pending: 'Pending',
  queued: 'Queued',
  in_progress: 'In progress',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_VARIANTS: Record<BroadcastStatus, BadgeVariant> = {
  draft: 'outline',
  pending: 'secondary',
  queued: 'secondary',
  in_progress: 'default',
  paused: 'outline',
  completed: 'default',
  failed: 'destructive',
  cancelled: 'outline',
};

/** Pure so status→badge mapping is unit-testable without rendering. */
export function statusBadgeVariant(status: BroadcastStatus): BadgeVariant {
  return STATUS_VARIANTS[status];
}

export function statusBadgeLabel(status: BroadcastStatus): string {
  return STATUS_LABELS[status];
}

export function StatusBadge({ status }: { status: BroadcastStatus }) {
  return <Badge variant={statusBadgeVariant(status)}>{statusBadgeLabel(status)}</Badge>;
}
