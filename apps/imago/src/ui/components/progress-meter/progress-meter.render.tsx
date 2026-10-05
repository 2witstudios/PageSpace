import type { ReactNode } from 'react';
import {
  progressMeterBarClass,
  progressMeterClass,
  progressMeterCountClass,
} from './progress-meter-class';

export type ProgressMeterRenderProps = {
  readonly done: number;
  readonly total: number;
};

/**
 * A task's mini progress bar with its count, e.g. ▬▬ 1/3. The native
 * <progress> carries value and max; the role is stated so the progressbar
 * contract does not rest on implicit mapping. The visible count repeats the
 * accessible name, so it is hidden from assistive tech.
 */
export function renderProgressMeter({ done, total }: ProgressMeterRenderProps): ReactNode {
  return (
    <span className={progressMeterClass}>
      <progress
        role="progressbar"
        className={progressMeterBarClass}
        value={done}
        max={total}
        aria-label={`${done} of ${total} subtasks done`}
      />
      <span className={progressMeterCountClass} aria-hidden="true">{`${done}/${total}`}</span>
    </span>
  );
}
