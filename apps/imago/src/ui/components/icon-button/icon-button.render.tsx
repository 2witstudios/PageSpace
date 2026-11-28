import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../cn';
import type { IconName } from '../icon/icon-names';
import { renderIcon } from '../icon/icon.render';
import { iconButtonClass, type IconButtonTone } from './icon-button-class';

export type IconButtonProps = {
  readonly name: IconName;
  /** Required accessible name — icon buttons have no visible text. */
  readonly label: string;
  readonly tone?: IconButtonTone;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

export function renderIconButton({
  name,
  label,
  tone = 'quiet',
  className,
  ...rest
}: IconButtonProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(iconButtonClass(tone), className)}
      {...rest}
    >
      {renderIcon({ name })}
    </button>
  );
}
