import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type StatTone = 'default' | 'positive' | 'negative' | 'warning';

const toneClasses: Record<StatTone, string> = {
  default: 'text-foreground',
  positive: 'text-emerald-600 dark:text-emerald-400',
  negative: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-400',
};

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  /** Small line under the value, e.g. a comparison or scope note. */
  hint?: React.ReactNode;
  icon?: LucideIcon;
  tone?: StatTone;
  isLoading?: boolean;
  className?: string;
}

/** The one stat-card idiom for the admin console. */
export function StatCard({ label, value, hint, icon: Icon, tone = 'default', isLoading, className }: StatCardProps) {
  return (
    <Card className={className}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-muted-foreground">{label}</p>
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
        </div>
        {isLoading ? (
          <Skeleton className="mt-2 h-7 w-24" />
        ) : (
          <p className={cn('mt-1 truncate text-2xl font-semibold tabular-nums', toneClasses[tone])}>{value}</p>
        )}
        {hint && !isLoading && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
