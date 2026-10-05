import type { ReactNode } from 'react';
import { renderAvatar } from '../avatar/avatar.render';
import {
  avatarGroupClass,
  avatarGroupFaceClass,
  avatarGroupRestClass,
} from './avatar-group-class';

export type AvatarGroupProps = {
  /** People or agents, by name. */
  readonly names: readonly string[];
  /** Which names are agents, drawn with the agent glyph. */
  readonly agents?: readonly string[];
  /** How many faces before the rest are counted. */
  readonly shown?: number;
  /** Leads the group's accessible name, such as "Assigned to". */
  readonly label?: string;
};

/** Overlapping 24px ringed faces, then "+N" for the rest. */
export function renderAvatarGroup({
  names,
  agents = [],
  shown = 3,
  label,
}: AvatarGroupProps): ReactNode {
  if (names.length === 0) return null;
  const faces = names.slice(0, shown);
  const rest = names.length - faces.length;
  const everyone = names.join(', ');
  return (
    <span
      className={avatarGroupClass}
      role="img"
      aria-label={label ? `${label} ${everyone}` : everyone}
    >
      {faces.map((name, index) => (
        <span key={`${index}:${name}`} className={avatarGroupFaceClass}>
          {renderAvatar({ name, size: 'stack', agent: agents.includes(name) })}
        </span>
      ))}
      {rest > 0 ? <span className={avatarGroupRestClass}>{`+${rest}`}</span> : null}
    </span>
  );
}
