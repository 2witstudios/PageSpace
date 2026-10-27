import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '../../components/icon/icon';
import { ProgressMeter } from '../../components/progress-meter/progress-meter';
import type { Progress } from '../task-tree/task-tree';
import type { StatusGroup } from '../task-model/task';
import {
  taskSiblingsBackClass,
  taskSiblingsDotClass,
  taskSiblingsDueClass,
  taskSiblingsGroupClass,
  taskSiblingsRowClass,
  taskSiblingsTitleClass,
} from './task-siblings-class';

export type TaskSiblingRow = {
  readonly pageId: string;
  readonly href: string;
  readonly title: string;
  readonly group: StatusGroup;
  readonly due: string;
  readonly current: boolean;
};

export type TaskSiblingGroup = {
  readonly name: string;
  readonly rows: readonly TaskSiblingRow[];
};

export type TaskSiblingsRenderProps = {
  readonly listHref: string;
  readonly listTitle: string;
  /** The list's own progress, as its row in the list pane shows it. */
  readonly progress: Progress;
  /** The status groups in the list's order; a group is drawn only when it holds a task. */
  readonly groups: readonly TaskSiblingGroup[];
};

const toneOf = (group: StatusGroup): string =>
  group === 'done' ? 'text-status-success' : group === 'in_progress' ? 'text-status-warning' : 'text-ink-faint';

/** The list a task sits in: a link back to it, then its tasks by status, the open one highlighted. */
export function renderTaskSiblings({ listHref, listTitle, progress, groups }: TaskSiblingsRenderProps): ReactNode {
  return (
    <>
      <Link href={listHref} prefetch className={taskSiblingsBackClass}>
        <Icon name="chevronLeft" size={14} />
        <span className={taskSiblingsTitleClass}>{listTitle}</span>
        {progress.total === 0 ? null : <ProgressMeter done={progress.done} total={progress.total} unit="tasks" />}
      </Link>
      {groups.map((group) => (
        <section key={group.name} aria-label={group.name}>
          <h3 className={taskSiblingsGroupClass}>
            {group.name} · {group.rows.length}
          </h3>
          <ul className="flex flex-col gap-px">
            {group.rows.map((row) => (
              <li key={row.pageId}>
                <Link
                  href={row.href}
                  prefetch
                  className={taskSiblingsRowClass(row.current)}
                  aria-current={row.current ? 'page' : undefined}
                >
                  <span aria-hidden="true" className={taskSiblingsDotClass(toneOf(row.group))} />
                  <span className={taskSiblingsTitleClass}>{row.title}</span>
                  {row.due === '' ? null : <span className={taskSiblingsDueClass}>{row.due}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
