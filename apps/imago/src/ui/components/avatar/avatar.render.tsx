import type { ReactNode } from 'react';
import type { Presence } from '../../types/presence/presence';
import { renderIcon } from '../icon/icon.render';
import { renderPresenceDot } from '../presence-dot/presence-dot.render';
import {
  avatarClass,
  avatarImageClass,
  avatarInitialsClass,
  avatarPresenceClass,
  type AvatarSize,
} from './avatar-class';

export type AvatarProps = {
  readonly name: string;
  readonly src?: string | undefined;
  readonly presence?: Presence;
  readonly size?: AvatarSize;
  /** An AI agent: drawn with the agent glyph on the accent tint. */
  readonly agent?: boolean;
};

/* A stacked face is too small for two letters once its neighbour overlaps
   it, and so is a list row's; each shows one. The full name is always in
   the accessible label. */
const initials = (name: string, size: AvatarSize): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, size === 'stack' || size === 'xs' ? 1 : 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

export function renderAvatar({
  name,
  src,
  presence,
  size = 'md',
  agent = false,
}: AvatarProps): ReactNode {
  if (agent)
    return (
      <span className={avatarClass(size, 'agent')} data-agent="true">
        {renderIcon({ name: 'bot', size: 12 })}
        <span className="sr-only">{name}</span>
      </span>
    );
  return (
    <span className={avatarClass(size)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a remote avatar of any origin, drawn at a fixed token size.
        <img src={src} alt="" className={avatarImageClass} />
      ) : (
        <span className={avatarInitialsClass} aria-hidden="true">
          {initials(name, size)}
        </span>
      )}
      {presence ? (
        <span className={avatarPresenceClass}>{renderPresenceDot({ presence })}</span>
      ) : null}
      <span className="sr-only">{name}</span>
    </span>
  );
}
