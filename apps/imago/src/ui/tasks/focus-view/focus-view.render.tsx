import type { ReactNode } from 'react';
import { Checkbox } from '../../components/checkbox/checkbox';
import { InlineAdd } from '../../components/inline-add/inline-add';
import type { Task } from '../task-model/task';
import { taskLevelClass, taskNoticeClass, taskRowClass, taskSlotClass, taskTitleClass } from '../task-row/task-row-class';
import type { TaskNotice } from '../tree-view/tree-view.render';
import type { DoneEntry, FocusGroup } from './focus';
import { focusCountClass, focusEmptyClass, focusGroupClass, focusHeadingClass, focusViewClass } from './focus-view-class';

export type FocusViewRenderProps = {
  /** The selected list's title: it names the loose group and the capture row. */
  readonly title: string;
  /** The selected list's page: a refused capture is reported at it. */
  readonly listPageId: string;
  /** The open leaves, grouped under their parents (focus.ts frontier). */
  readonly groups: readonly FocusGroup[];
  /** What was completed on the injected clock's day (focus.ts doneToday). */
  readonly done: readonly DoneEntry[];
  /** Why an edit was refused: at a task's id, or at the list page for a capture. */
  readonly notice: TaskNotice | null;
  /** Void action: ticks a task, or unticks it. */
  readonly toggleComplete: (taskId: string) => void;
  /** Void action: adds a task with this title to the selected list. */
  readonly capture: (title: string) => void;
};

const noticeFor = (notice: TaskNotice | null, at: string): ReactNode =>
  notice?.at === at ? (
    <p role="status" className={taskNoticeClass}>
      {notice.message}
    </p>
  ) : null;

/** A Focus row is a leaf: the tree's row with an empty lead slot, no caret. */
const row = (props: FocusViewRenderProps, task: Task, done: boolean): ReactNode => (
  <li key={task.id} data-task={task.id}>
    <div className={taskRowClass}>
      <span className={taskSlotClass} aria-hidden="true" />
      <Checkbox checked={done} label={`Complete ${task.title}`} toggle={() => props.toggleComplete(task.id)} />
      <span className={taskTitleClass(done)} data-title="">
        {task.title}
      </span>
    </div>
    {noticeFor(props.notice, task.id)}
  </li>
);

const group = (props: FocusViewRenderProps, entry: FocusGroup): ReactNode => (
  <section key={entry.id} aria-label={entry.heading} className={focusGroupClass}>
    <h3 className={focusHeadingClass}>{entry.heading}</h3>
    <ul className={taskLevelClass}>{entry.tasks.map((task) => row(props, task, false))}</ul>
  </section>
);

/**
 * The Focus view: the selected list's frontier — every open leaf, grouped
 * under the parent it serves, soonest due first — then "Done today", then a
 * capture row that adds a task to the selected list.
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
      <section aria-label="Done today" className={focusGroupClass}>
        <h3 className={focusHeadingClass}>
          Done today
          <span className={focusCountClass}>{done.length}</span>
        </h3>
        {done.length === 0 ? (
          <p className={focusEmptyClass}>Nothing done yet today.</p>
        ) : (
          <ul className={taskLevelClass}>{done.map((entry) => row(props, entry.task, true))}</ul>
        )}
      </section>
      <div data-capture="">
        <InlineAdd label={`Add task to ${title}`} placeholder="Task title" add={capture} />
        {noticeFor(notice, listPageId)}
      </div>
    </div>
  );
}
