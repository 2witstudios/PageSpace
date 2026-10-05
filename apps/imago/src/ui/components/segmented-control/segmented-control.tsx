'use client';

import {
  renderSegmentedControl,
  type SegmentedControlRenderProps,
} from './segmented-control.render';

export type SegmentedControlProps<T extends string> = SegmentedControlRenderProps<T>;

/** A controlled segmented control: the caller owns `value` and what `select` does. */
export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  return renderSegmentedControl(props);
}
