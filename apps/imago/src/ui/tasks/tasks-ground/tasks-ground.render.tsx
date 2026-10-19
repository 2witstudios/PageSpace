import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '../../components/icon/icon';
import { renderErrorState } from '../../frame/edge-state/edge-state.render';
import type { StatusGroupFilter } from '../task-model/task';
import type { GroundRow, GroundSection } from './ground-rows';
import {
  avatarClass,
  avatarOverlapClass,
  circleClass,
  dueClass,
  groundClass,
  groundHeadingClass,
  groundInnerClass,
  groundNoticeClass,
  groundSubtitleClass,
  priorityBarClass,
  priorityClass,
  peopleClass,
  rowClass,
  rowMetaClass,
  rowTitleClass,
  sectionClass,
  sectionCountClass,
  sectionHeadClass,
  statusDotClass,
  statusGroupClass,
  statusOptionClass,
  statusPillClass,
} from './tasks-ground-class';

const STATUS_OPTIONS: readonly { readonly value: StatusGroupFilter; readonly label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

/** What the ground says when its rows are none: the status's own word for it. */
export const emptyLabelFor = (status: StatusGroupFilter): string =>
  status === 'completed' ? 'No completed tasks in this view.' : status === 'active' ? 'No open tasks in this view.' : 'No tasks in this view.';

export type TasksGroundRenderProps = {
  readonly heading: string;
  /** undefined while the count of lists is unknown. */
  readonly subtitle: string | undefined;
  readonly status: StatusGroupFilter;
  readonly onStatus: (status: StatusGroupFilter) => void;
  readonly state:
    | { readonly kind: 'loading' }
    | { readonly kind: 'error'; readonly retry: () => void }
    | { readonly kind: 'ready'; readonly sections: readonly GroundSection[]; readonly driveId: string };
};

/** The three priority bars, shortest first: their heights as the theme's h-1, h-2 and h-3. */
const PRIORITY_BARS = [4, 8, 12] as const;

const initials = (name: string): string => {
  const letters = name.trim().split(/\s+/).map((part) => part.charAt(0)).join('').slice(0, 2).toUpperCase();
  return letters === '' ? '?' : letters;
};

/** One row: the circle, the title and list, its status, priority, people and due date. */
function renderRow(row: GroundRow, driveId: string): ReactNode {
  const href = `/${encodeURIComponent(driveId)}/tasks/${encodeURIComponent(row.pageId)}`;
  const priorityLevel = row.priority === 'high' ? 3 : row.priority === 'medium' ? 2 : 1;
  return (
    <div key={row.id} role="row" className={rowClass}>
      <span aria-hidden="true" className={circleClass(row.done)}>
        {row.done ? <Icon name="check" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Link href={href} prefetch className={rowTitleClass}>
          {row.title}
        </Link>
        <span className={rowMetaClass}>{row.list}</span>
      </span>
      <span className={statusPillClass}>
        <span aria-hidden="true" className={statusDotClass(row.statusGroup)} />
        {row.statusLabel}
      </span>
      <span role="img" aria-label={`Priority ${row.priority}`} className={priorityClass}>
        {PRIORITY_BARS.map((height, index) => (
          <span key={height} aria-hidden="true" className={priorityBarClass(index < priorityLevel, height, row.priority)} />
        ))}
      </span>
      <span className={peopleClass}>
        {row.people.map((person, index) => (
          <span
            key={`${person.type}-${person.id}`}
            title={person.name}
            className={`${avatarClass(person.type === 'agent')} ${index > 0 ? avatarOverlapClass : ''}`}
          >
            {initials(person.name)}
          </span>
        ))}
      </span>
      <span className={dueClass(row.dueTone)}>{row.due}</span>
    </div>
  );
}

/**
 * The Tasks index: the viewer's tasks in one status group, grouped by due
 * date. It fills the middle column, with Imago docked beside it.
 */
export function renderTasksGround({ heading, subtitle, status, onStatus, state }: TasksGroundRenderProps): ReactNode {
  const rows = state.kind === 'ready' ? state.sections.reduce((count, section) => count + section.rows.length, 0) : null;
  return (
    <section aria-label={heading} className={groundClass}>
      <div className={groundInnerClass}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className={groundHeadingClass}>{heading}</h2>
            {subtitle === undefined ? null : <p className={groundSubtitleClass}>{subtitle}</p>}
          </div>
          <div role="group" aria-label="Status" className={statusGroupClass}>
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={option.value === status}
                className={statusOptionClass(option.value === status)}
                onClick={() => onStatus(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {state.kind === 'loading' ? (
          <p role="status" className={groundNoticeClass}>
            Loading tasks…
          </p>
        ) : state.kind === 'error' ? (
          renderErrorState({ title: 'Could not load tasks', retry: state.retry })
        ) : rows === 0 ? (
          <p className={groundNoticeClass}>{emptyLabelFor(status)}</p>
        ) : (
          state.sections
            .filter((section) => section.rows.length > 0)
            .map((section) => (
              <section key={section.name} className={sectionClass} aria-label={section.name}>
                <h3 className={sectionHeadClass}>
                  {section.name}
                  <span className={sectionCountClass}>{section.rows.length}</span>
                </h3>
                {section.rows.map((row) => renderRow(row, state.driveId))}
              </section>
            ))
        )}
      </div>
    </section>
  );
}
