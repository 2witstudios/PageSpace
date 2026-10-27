import { renderAvatar, type AvatarProps } from './avatar.render';

export function Avatar(props: AvatarProps) {
  return renderAvatar(props);
}

export type { AvatarProps } from './avatar.render';
export type { AvatarSize } from './avatar-class';
