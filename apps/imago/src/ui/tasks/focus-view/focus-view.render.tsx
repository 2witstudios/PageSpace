import Link from 'next/link';
import type { ReactNode } from 'react';
import { Checkbox } from '../../components/checkbox/checkbox';
import { InlineAdd } from '../../components/inline-add/inline-add';
import { dueDay } from '../task-detail/due-date';
import { dueLabel, dueToneOf } from '../task-meta/task-meta';
import type { Task } from '../task-model/task';
import { taskLevelClass, taskNoticeClass, taskRowClass, taskSlotClass, taskTitleClass } from '../task-row/task-row-class';
import { treeDueClass } from '../tree-view/tree-view-class';
import type { TaskNotice } from '../tree-view/tree-view.render';
import type { DoneEntry, FocusGroup } from './focus';
import {
  focusCountClass,
  focusDueChipClass,
  focusEmptyClass,
  focusGroupClass,
  focusHeadingClass,
  focusMoreClass,
  focusToggleClass,
  focusViewClass,
} from './focus-view-class';

/** How many leaves a group shows before "+N more". */
export const FOCUS_GROUP_LIMIT = 5;

export type FocusViewRenderProps = {
  /** Where captured tasks go: the selected list's title, for the capture row's name. */
  readonly title: string;
  /** The capture row's list page: a refused capture is reported at it. */
  readonly listPageId: string;
  /** The open leaves, grouped under their parents (focus.ts frontier). */
  readonly groups: readonly FocusGroup[];
  /** What was completed on the injected clock's day (focus.ts doneToday); null where it is not known. */
  readonly done: readonly DoneEntry[] | null;
  /** Why an edit was refused: at a task's id, or at the list page for a capture. */
  readonly notice: TaskNotice | null;
  /** Void action: ticks a task, or unticks it; absent for a viewer who may not, whose boxes are read-only. */
  readonly toggleComplete?: (taskId: string) => void;
  /** Void action: adds a task with this title to the selected list; absent for a viewer who may not. */
  readonly capture?: (title: string) => void;
  /** The viewer's own day, YYYY-MM-DD; rows show their due dates against it. */
  readonly today?: string;
  /** Where a task's detail opens. */
  readonly taskHref?: (task: Task) => string;
  /** The groups showing all of their leaves. */
  readonly expandedGroups?: readonly string[];
  /** Void action: shows a group's every leaf, or folds it back. */
  readonly toggleGroup?: (groupId: string) => void;
  /** Whether "Done today" lists its tasks. */
  readonly doneOpen?: boolean;
  readonly toggleDone?: () => void;
};

const noticeFor = (notice: TaskNotice | null, at: string): ReactNode =>
  notice?.at === at ? (
    <p role="status" className={taskNoticeClass}>
      {notice.message}
    </p>
  ) : null;

/** A Focus row is a leaf: the tree's row with an empty lead slot, no caret, and its due date. */
const row = (props: FocusViewRenderProps, task: Task, done: boolean): ReactNode => {
  const tone = props.today === undefined ? null : dueToneOf(task.dueDate, props.today, done);
  const { toggleComplete } = props;
  return (
    <li key={task.id} data-task={task.id}>
      <div className={taskRowClass}>
        <span className={taskSlotClass} aria-hidden="true" />
        <Checkbox
          checked={done}
          label={`Complete ${task.title}`}
          toggle={toggleComplete === undefined ? undefined : () => toggleComplete(task.id)}
        />
        {props.taskHref === undefined ? (
          <span className={taskTitleClass(done)} data-title="">
            {task.title}
          </span>
        ) : (
          <Link href={props.taskHref(task)} prefetch className={taskTitleClass(done)} data-title="">
            {task.title}
          </Link>
        )}
        {tone === null || props.today === undefined ? null : (
          <time dateTime={dueDay(task.dueDate)} data-tone={tone} className={treeDueClass(tone)}>
            {dueLabel(task.dueDate, props.today)}
          </time>
        )}
      </div>
      {noticeFor(props.notice, task.id)}
    </li>
  );
};

/** The parent's due date beside the heading: when the whole branch is due. */
const headingDue = (props: FocusViewRenderProps, entry: FocusGroup): ReactNode => {
  const due = entry.parent?.dueDate ?? null;
  if (due === null || props.today === undefined) return null;
  const tone = dueToneOf(due, props.today, false);
  return tone === null ? null : (
    <span data-tone={tone} className={focusDueChipClass(tone)}>
      {`Due ${dueLabel(due, props.today)}`}
    </span>
  );
};

const group = (props: FocusViewRenderProps, entry: FocusGroup): ReactNode => {
  const open = props.expandedGroups?.includes(entry.id) === true;
  const shown = open ? entry.tasks : entry.tasks.slice(0, FOCUS_GROUP_LIMIT);
  const rest = entry.tasks.length - shown.length;
  return (
    <section key={entry.id} aria-label={entry.heading} className={focusGroupClass}>
      <h3 className={focusHeadingClass}>
        <span className="truncate">{entry.heading}</span>
        {headingDue(props, entry)}
      </h3>
      <ul className={taskLevelClass}>{shown.map((task) => row(props, task, false))}</ul>
      {props.toggleGroup === undefined || (rest === 0 && !open) || entry.tasks.length <= FOCUS_GROUP_LIMIT ? null : (
        <button type="button" className={focusMoreClass} onClick={() => props.toggleGroup?.(entry.id)}>
          {open ? 'Show fewer' : `${rest} more`}
        </button>
      )}
    </section>
  );
};

const doneSection = (props: FocusViewRenderProps, done: readonly DoneEntry[]): ReactNode => {
  const open = props.toggleDone === undefined || props.doneOpen === true;
  return (
    <section aria-label="Done today" className={focusGroupClass}>
      <h3 className={focusHeadingClass}>
        {props.toggleDone === undefined ? (
          'Done today'
        ) : (
          <button type="button" aria-expanded={open} className={focusToggleClass} onClick={props.toggleDone}>
            Done today
          </button>
        )}
        <span className={focusCountClass}>{done.length}</span>
      </h3>
      {!open ? null : done.length === 0 ? (
        <p className={focusEmptyClass}>Nothing done yet today.</p>
      ) : (
        <ul className={taskLevelClass}>{done.map((entry) => row(props, entry.task, true))}</ul>
      )}
    </section>
  );
};

/**
 * The Focus view: the frontier — every open leaf, grouped under the parent
 * it serves, soonest due first, each group folding past five — then "Done
 * today", then a capture row that adds a task to the selected list.
 */
export function renderFocusView(props: FocusViewRenderProps): ReactNode {
  const { title, listPageId, groups, done, notice, capture } = props;
  return (
    <div className={focusViewClass}>
      {groups.length === 0 ? (
        <p className={focusEmptyClass}>{`Nothing open in ${title}.`}</p>
      ) : (
        groups.map((entry) => group(props, entry))
      )}
      {done === null ? null : doneSection(props, done)}
      {capture === undefined ? null : (
        <div data-capture="">
          <InlineAdd label={`Add task to ${title}`} placeholder="Task title" add={capture} />
          {noticeFor(notice, listPageId)}
        </div>
      )}
    </div>
  );
}
