import type { ReactNode } from 'react';
import {
  progressMeterBarClass,
  progressMeterClass,
  progressMeterCountClass,
} from './progress-meter-class';

export type ProgressMeterRenderProps = {
  readonly done: number;
  readonly total: number;
  /** What it counts, for its accessible name; a task's subtasks unless given. */
  readonly unit?: string;
};

/**
 * A task's mini progress bar with its count, e.g. ▬▬ 1/3. The native
 * <progress> carries value and max; the role is stated so the progressbar
 * contract does not rest on implicit mapping. The visible count repeats the
 * accessible name, so it is hidden from assistive tech.
 */
export function renderProgressMeter({ done, total, unit = 'subtasks' }: ProgressMeterRenderProps): ReactNode {
  return (
    <span className={progressMeterClass}>
      <progress
        role="progressbar"
        className={progressMeterBarClass}
        value={done}
        max={total}
        aria-label={`${done} of ${total} ${unit} done`}
      />
      <span className={progressMeterCountClass} aria-hidden="true">{`${done}/${total}`}</span>
    </span>
  );
}
