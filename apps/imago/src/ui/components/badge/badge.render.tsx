import type { ReactNode } from 'react';
import { badgeClass, type BadgeTone } from './badge-class';

export type BadgeProps = {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
};

export function renderBadge({ tone = 'neutral', children }: BadgeProps): ReactNode {
  return <span className={badgeClass(tone)}>{children}</span>;
}
