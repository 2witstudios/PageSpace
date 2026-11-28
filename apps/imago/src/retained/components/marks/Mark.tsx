import type { MarkColor } from '@pagespace/lib/avatars/avatar-core';
import { Avatar, AvatarFallback, AvatarImage } from '@/retained/components/ui/avatar';
import { cn } from '@/retained/lib/utils';

const SIZES = {
  sm: 'h-[18px] w-[18px] rounded text-[9px]',
  md: 'h-6 w-6 rounded-md text-[11px]',
  lg: 'h-10 w-10 rounded-[10px] text-base',
} as const;

/**
 * The tile each mark palette key paints (MARK_COLORS). A saturated 600 step under white, so the
 * initial reads the same in light and dark.
 */
export const MARK_COLOR_CLASSES: Readonly<Record<MarkColor, string>> = {
  slate: 'bg-slate-600 text-white',
  red: 'bg-red-600 text-white',
  orange: 'bg-orange-600 text-white',
  amber: 'bg-amber-600 text-white',
  green: 'bg-green-600 text-white',
  teal: 'bg-teal-600 text-white',
  blue: 'bg-blue-600 text-white',
  indigo: 'bg-indigo-600 text-white',
  violet: 'bg-violet-600 text-white',
  pink: 'bg-pink-600 text-white',
};

export interface MarkProps {
  name: string;
  avatarUrl?: string | null;
  /** The palette key the initial sits on; the primary color without one. */
  color?: MarkColor | null;
  size?: keyof typeof SIZES;
  /** Set where the name is already shown beside the mark, so screen readers do not hear it twice. */
  decorative?: boolean;
  /** What the mark is called when its name is blank. */
  fallbackLabel?: string;
  className?: string;
}

/** The first user-perceived character of `name` (a whole emoji, not half a surrogate pair), upper-cased. */
export function markInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Segmenter
    ? new Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)[Symbol.iterator]().next().value?.segment
    : Array.from(trimmed)[0];
  return (first ?? '?').toUpperCase();
}

/**
 * A mark (canvas .orgmark) for anything with a name and an avatar — an org, a drive: its avatar, or its
 * initial on its color. Built on the app's Avatar, so an avatar URL that fails to load (or is not allowed)
 * falls back to the initial. Named by its name unless `decorative`.
 */
export function Mark({ name, avatarUrl, color, size = 'md', decorative = false, fallbackLabel = 'Mark', className }: MarkProps) {
  const label = name.trim() || fallbackLabel;
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': label };
  return (
    <Avatar {...a11y} className={cn('shrink-0 font-bold', SIZES[size], className)}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" className="object-cover" /> : null}
      <AvatarFallback className={cn('rounded-[inherit]', color ? MARK_COLOR_CLASSES[color] : 'bg-primary text-primary-foreground')}>
        {markInitial(name)}
      </AvatarFallback>
    </Avatar>
  );
}
