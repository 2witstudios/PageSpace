import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

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

/** The first user-perceived character of `name` (a whole emoji, not half a surrogate pair), upper-cased. */
export function orgInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Segmenter
    ? new Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)[Symbol.iterator]().next().value?.segment
    : Array.from(trimmed)[0];
  return (first ?? '?').toUpperCase();
}

/**
 * An organization's mark (canvas .orgmark): its avatar, or its initial on the primary color. Built on the
 * app's Avatar, so an avatar URL that fails to load (or is not allowed) falls back to the initial. Semantic
 * tokens only, so it holds in light and dark. Named by the org unless `decorative`.
 */
export function OrgMark({ name, avatarUrl, size = 'md', decorative = false, className }: OrgMarkProps) {
  const label = name.trim() || 'Organization';
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': label };
  return (
    <Avatar {...a11y} className={cn('shrink-0 font-bold', SIZES[size], className)}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" className="object-cover" /> : null}
      <AvatarFallback className="rounded-[inherit] bg-primary text-primary-foreground">{orgInitial(name)}</AvatarFallback>
    </Avatar>
  );
}
