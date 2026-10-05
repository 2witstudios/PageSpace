import { renderProgressMeter, type ProgressMeterRenderProps } from './progress-meter.render';

export type ProgressMeterProps = ProgressMeterRenderProps;

/** A task's mini progress bar with its count. */
export function ProgressMeter(props: ProgressMeterProps) {
  return renderProgressMeter(props);
}
