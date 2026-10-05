import { cn } from '@/lib/utils/index';

const SIZES = {
  sm: 'h-[18px] w-[18px] rounded text-[9px]',
  md: 'h-6 w-6 rounded-md text-[11px]',
  lg: 'h-10 w-10 rounded-[10px] text-base',
} as const;

export interface OrgMarkProps {
  name: string;
  avatarUrl?: string | null;
  size?: keyof typeof SIZES;
  /** Set where the org's name is already shown beside the mark, so screen readers do not hear it twice. */
  decorative?: boolean;
  className?: string;
}

/**
 * An organization's mark (canvas .orgmark): its avatar, or its initial on the primary color. Semantic
 * tokens only, so it holds in light and dark. Named by the org unless `decorative`.
 */
export function OrgMark({ name, avatarUrl, size = 'md', decorative = false, className }: OrgMarkProps) {
  const label = name.trim() || 'Organization';
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': label };
  const classes = cn('inline-flex shrink-0 items-center justify-center overflow-hidden font-bold', SIZES[size], className);
  if (avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- an org avatar is an arbitrary https URL
    return <img src={avatarUrl} alt={decorative ? '' : label} aria-hidden={decorative || undefined} className={cn(classes, 'object-cover')} />;
  }
  return (
    <span {...a11y} className={cn(classes, 'bg-primary text-primary-foreground')}>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
