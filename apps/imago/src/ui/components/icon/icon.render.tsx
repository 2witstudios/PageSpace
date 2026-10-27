import type { ReactNode, SVGProps } from 'react';
import { cn } from '../../cn';
import { icons, type IconName } from './icon-names';

export type IconProps = {
  readonly name: IconName;
  /** Accessible name; omit for decorative icons. */
  readonly label?: string;
  readonly size?: number;
  readonly className?: string;
} & Omit<
  SVGProps<SVGSVGElement>,
  // The stroke is fixed and the label alone decides whether assistive
  // technology sees the icon; `absoluteStrokeWidth` is lucide's own prop.
  'name' | 'children' | 'ref' | 'strokeWidth' | 'aria-hidden'
> & { readonly absoluteStrokeWidth?: never };

/**
 * A lucide icon at PageSpace's thin 1.5 stroke, 16px unless sized. The
 * caller's props go first, so nothing it passes overrides the stroke or the
 * accessibility attributes.
 */
export function renderIcon({
  name,
  label,
  size = 16,
  className,
  ...rest
}: IconProps): ReactNode {
  const Glyph = icons[name];
  return (
    <Glyph
      {...rest}
      size={size}
      strokeWidth={1.5}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      absoluteStrokeWidth={false}
      className={cn('block shrink-0', className)}
    />
  );
}
