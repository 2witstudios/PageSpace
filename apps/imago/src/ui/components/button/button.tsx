import { renderButton, type ButtonProps } from './button.render';

export function Button(props: ButtonProps) {
  return renderButton(props);
}

export type { ButtonProps } from './button.render';
