import { renderIcon, type IconProps } from './icon.render';

export function Icon(props: IconProps) {
  return renderIcon(props);
}

export type { IconProps } from './icon.render';
export type { IconName } from './icon-names';
