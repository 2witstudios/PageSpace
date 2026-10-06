'use client';

import { renderCheckbox, type CheckboxRenderProps } from './checkbox.render';

export type CheckboxProps = CheckboxRenderProps;

/** A controlled checkbox: the caller owns `checked` and what `toggle` does. */
export function Checkbox(props: CheckboxProps) {
  return renderCheckbox(props);
}
