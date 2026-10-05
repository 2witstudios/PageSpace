import type { ReactNode, SVGProps } from 'react';
import { cn } from '../../cn';
import { icons, type IconName } from './icon-names';

export type IconProps = {
  readonly name: IconName;
  /** Accessible name; omit for decorative icons. */
  readonly label?: string;
  readonly size?: number;
  readonly className?: string;
} & Omit<SVGProps<SVGSVGElement>, 'name' | 'children' | 'ref'>;

/** A lucide icon at PageSpace's thin 1.5 stroke, 16px unless sized. */
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
      size={size}
      strokeWidth={1.5}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('block shrink-0', className)}
      {...rest}
    />
  );
}
