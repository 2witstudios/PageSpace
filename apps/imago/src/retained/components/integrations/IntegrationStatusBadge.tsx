'use client';

import { Badge } from '@/retained/components/ui/badge';
import type { ConnectionStatus } from '@/retained/components/integrations/types';

const statusConfig: Record<ConnectionStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  active: { label: 'Active', variant: 'default' },
  pending: { label: 'Pending', variant: 'secondary' },
  expired: { label: 'Expired', variant: 'destructive' },
  error: { label: 'Error', variant: 'destructive' },
  revoked: { label: 'Revoked', variant: 'outline' },
};

interface IntegrationStatusBadgeProps {
  status: ConnectionStatus;
}

export function IntegrationStatusBadge({ status }: IntegrationStatusBadgeProps) {
  const config = statusConfig[status] ?? { label: status, variant: 'outline' as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
