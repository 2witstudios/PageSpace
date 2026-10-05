import { cn } from '@/lib/utils/index';

const SIZES = { sm: 'h-[18px] w-[18px] rounded text-[9px]', md: 'h-6 w-6 rounded-md text-[11px]', lg: 'h-10 w-10 rounded-[10px] text-base' } as const;

/** The org's mark: its avatar, or its initial on the primary color (canvas .orgmark). */
export function OrgMark({ name, avatarUrl, size = 'md', className }: { name: string; avatarUrl?: string | null; size?: keyof typeof SIZES; className?: string }) {
  const classes = cn('inline-flex shrink-0 items-center justify-center overflow-hidden font-bold', SIZES[size], className);
  if (avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- an org avatar is an arbitrary https URL
    return <img src={avatarUrl} alt="" className={cn(classes, 'object-cover')} />;
  }
  return (
    <span aria-hidden className={cn(classes, 'bg-primary text-primary-foreground')}>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
