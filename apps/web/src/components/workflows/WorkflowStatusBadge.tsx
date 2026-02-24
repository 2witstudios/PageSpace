'use client';

import { Badge } from '@/components/ui/badge';

const STATUS_CONFIG = {
  never_run: { label: 'Never run', variant: 'secondary' as const },
  success: { label: 'Success', variant: 'default' as const },
  error: { label: 'Error', variant: 'destructive' as const },
  running: { label: 'Running', variant: 'outline' as const },
} as const;

export function WorkflowStatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.never_run;

  return (
    <Badge variant={config.variant} className={status === 'running' ? 'animate-pulse' : ''}>
      {config.label}
    </Badge>
  );
}
