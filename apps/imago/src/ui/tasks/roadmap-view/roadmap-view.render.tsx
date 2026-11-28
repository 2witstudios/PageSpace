import Link from 'next/link';
import type { KeyboardEvent, PointerEvent, ReactNode, Ref } from 'react';
import { renderIconButton } from '../../components/icon-button/icon-button.render';
import { renderSegmentedControl } from '../../components/segmented-control/segmented-control.render';
import type { Task } from '../task-model/task';
import {
  dayWidths,
  rowLabel,
  spanOf,
  timelineWidth,
  xForDay,
  zoomSegments,
  type DragDates,
  type DragMode,
  type Header,
  type Range,
  type RoadmapRow,
  type Zoom,
} from './roadmap';
import {
  roadmapBarClass,
  roadmapCanvasClass,
  roadmapChipClass,
  roadmapClass,
  roadmapControlsClass,
  roadmapDotClass,
  roadmapEmptyClass,
  roadmapFillClass,
  roadmapGhostClass,
  roadmapGridClass,
  roadmapHandleClass,
  roadmapHeadClass,
  roadmapLaneClass,
  roadmapLaneTitleClass,
  roadmapLanesClass,
  roadmapLanesHeadClass,
  roadmapMilestoneClass,
  roadmapMonthClass,
  roadmapNoticeClass,
  roadmapOverdueClass,
  roadmapRowClass,
  roadmapScheduleClass,
  roadmapStepClass,
  roadmapTickClass,
  roadmapTimelineClass,
  roadmapTodayClass,
  roadmapTodayLabelClass,
  roadmapTodayLineClass,
  roadmapTooltipClass,
  roadmapTrayClass,
  roadmapTrayHeadClass,
  roadmapTrayListClass,
  roadmapWeekendClass,
} from './roadmap-view-class';

/** A drag under way: where the held mark will land, and what to say about it. */
export type RoadmapDragView = {
  readonly taskId: string;
  readonly dates: DragDates;
  readonly label: string;
};

export type RoadmapRenderProps = {
  /** The timeline's accessible name. */
  readonly label: string;
  readonly zoom: Zoom;
  /** Void action: picks a zoom. */
  readonly setZoom: (zoom: Zoom) => void;
  /** Void action: scrolls today into view. */
  readonly goToday: () => void;
  /** Void action: scrolls a period back (-1) or on (1). */
  readonly step: (direction: -1 | 1) => void;
  readonly rows: readonly RoadmapRow[];
  readonly unscheduled: readonly Task[];
  readonly range: Range;
  readonly header: Header;
  readonly today: string;
  readonly editable: boolean;
  readonly taskHref?: (task: Task) => string;
  /** The horizontally scrolling timeline, for the controls to scroll. */
  readonly timelineRef: Ref<HTMLDivElement>;
  readonly drag: RoadmapDragView | null;
  /** Void action: a pointer went down on a bar's edge or body. */
  readonly startDrag: (row: RoadmapRow, mode: DragMode, event: PointerEvent<HTMLElement>) => void;
  /** Void action: an arrow key on a handle. */
  readonly nudge: (row: RoadmapRow, mode: DragMode, event: KeyboardEvent<HTMLElement>) => void;
  /** Void action: gives an unscheduled task a due date. */
  readonly schedule: (task: Task) => void;
  /** Why the last change was refused. */
  readonly notice: string | null;
};

const title = (task: Task, done: boolean, href: string | undefined): ReactNode =>
  href === undefined ? (
    <span className={roadmapLaneTitleClass(done)} data-title="">
      {task.title}
    </span>
  ) : (
    <Link href={href} prefetch className={roadmapLaneTitleClass(done)} data-title="">
      {task.title}
    </Link>
  );

const controls = ({ zoom, setZoom, goToday, step }: RoadmapRenderProps): ReactNode => (
  <div className={roadmapControlsClass}>
    {renderSegmentedControl({ label: 'Zoom', segments: zoomSegments, value: zoom, select: setZoom })}
    <button type="button" className={roadmapTodayClass} onClick={goToday}>
      Today
    </button>
    <div className={roadmapStepClass}>
      {renderIconButton({ name: 'chevronLeft', label: 'Earlier', onClick: () => step(-1) })}
      {renderIconButton({ name: 'chevronRight', label: 'Later', onClick: () => step(1) })}
    </div>
  </div>
);

const lanes = ({ rows, taskHref }: RoadmapRenderProps): ReactNode => (
  <div className={roadmapLanesClass}>
    <div className={roadmapLanesHeadClass}>Task</div>
    <ul aria-label="Lanes">
      {rows.map((row) => (
        <li key={row.task.id} data-lane={row.task.id} className={roadmapLaneClass(row.depth)}>
          <span className={roadmapDotClass(row.group)} title={row.statusName} aria-hidden="true" />
          {title(row.task, row.done, taskHref?.(row.task))}
        </li>
      ))}
    </ul>
  </div>
);

const head = ({ header, range, today, zoom }: RoadmapRenderProps): ReactNode => {
  const width = dayWidths[zoom];
  return (
    <div className={roadmapHeadClass} aria-hidden="true">
      {header.months.map((month) => (
        <span key={month.day} data-month={month.day} className={roadmapMonthClass} style={{ left: month.x }}>
          {month.label}
        </span>
      ))}
      {header.ticks.map((tick) => (
        <span key={tick.day} data-tick={tick.day} className={roadmapTickClass(tick.weekend)} style={{ left: tick.x }}>
          {tick.label}
        </span>
      ))}
      <span className={roadmapTodayLabelClass} style={{ left: xForDay(range, today, width) + width / 2 }}>
        Today
      </span>
    </div>
  );
};

const handle = (props: RoadmapRenderProps, row: RoadmapRow, edge: 'start' | 'due'): ReactNode => (
  <button
    type="button"
    data-handle={edge}
    className={roadmapHandleClass(edge)}
    aria-label={`${edge === 'start' ? 'Start' : 'Due'} date of ${row.task.title}`}
    onPointerDown={(event) => {
      event.stopPropagation();
      props.startDrag(row, edge, event);
    }}
    onKeyDown={(event) => props.nudge(row, edge, event)}
  />
);

const mark = (props: RoadmapRenderProps, row: RoadmapRow): ReactNode => {
  const { range, zoom, editable } = props;
  const width = dayWidths[zoom];
  if (row.mark.kind === 'none') return null;
  if (row.mark.kind === 'milestone') {
    return (
      <div
        data-milestone={row.task.id}
        role="group"
        aria-label={rowLabel(row)}
        className={roadmapMilestoneClass(row.group, editable)}
        style={{ left: xForDay(range, row.mark.due, width) + width / 2 }}
        onPointerDown={editable ? (event) => props.startDrag(row, 'move', event) : undefined}
      >
        {editable ? handle(props, row, 'due') : null}
      </div>
    );
  }
  const span = spanOf(range, row.mark.start, row.mark.due, width);
  return (
    <div
      data-bar={row.task.id}
      role="group"
      aria-label={rowLabel(row)}
      className={roadmapBarClass(row.group, editable)}
      style={{ left: span.left, width: span.width }}
      onPointerDown={editable ? (event) => props.startDrag(row, 'move', event) : undefined}
    >
      <span data-fill="" className={roadmapFillClass(row.group)} style={{ width: `${row.progress * 100}%` }} />
      {editable ? handle(props, row, 'start') : null}
      {editable ? handle(props, row, 'due') : null}
    </div>
  );
};

const ghost = (props: RoadmapRenderProps, row: RoadmapRow): ReactNode => {
  const { drag, range, zoom } = props;
  if (drag === null || drag.taskId !== row.task.id) return null;
  const span = spanOf(range, drag.dates.start, drag.dates.due, dayWidths[zoom]);
  return (
    <div data-ghost="" className={roadmapGhostClass} style={{ left: span.left, width: span.width }}>
      <span role="status" className={roadmapTooltipClass}>
        {drag.label}
      </span>
    </div>
  );
};

const timeline = (props: RoadmapRenderProps): ReactNode => {
  const { rows, range, header, zoom, today, label, timelineRef } = props;
  const width = dayWidths[zoom];
  return (
    <div ref={timelineRef} data-timeline="" role="group" aria-label={label} className={roadmapTimelineClass}>
      <div className={roadmapCanvasClass} style={{ width: timelineWidth(range, width) }}>
        {header.weekends.map((weekend) => (
          <span
            key={weekend.left}
            data-weekend=""
            aria-hidden="true"
            className={roadmapWeekendClass}
            style={{ left: weekend.left, width: weekend.width, top: 0 }}
          />
        ))}
        {head(props)}
        {rows.map((row) => (
          <div key={row.task.id} data-row={row.task.id} className={roadmapRowClass}>
            {row.overdue === null ? null : (
              <span
                data-overdue=""
                aria-hidden="true"
                className={roadmapOverdueClass}
                style={spanOf(range, row.overdue.from, row.overdue.to, width)}
              />
            )}
            {mark(props, row)}
            {ghost(props, row)}
          </div>
        ))}
        <span
          data-today={today}
          aria-hidden="true"
          className={roadmapTodayLineClass}
          style={{ left: xForDay(range, today, width) + width / 2 }}
        />
      </div>
    </div>
  );
};

const tray = ({ unscheduled, editable, taskHref, schedule }: RoadmapRenderProps): ReactNode =>
  unscheduled.length === 0 ? null : (
    <section aria-label="Unscheduled" className={roadmapTrayClass}>
      <h3 className={roadmapTrayHeadClass}>Unscheduled</h3>
      <ul className={roadmapTrayListClass}>
        {unscheduled.map((task) => (
          <li key={task.id} data-unscheduled={task.id} className={roadmapChipClass}>
            {title(task, false, taskHref?.(task))}
            {editable ? (
              <button
                type="button"
                className={roadmapScheduleClass}
                aria-label={`Schedule ${task.title}`}
                onClick={() => schedule(task)}
              >
                Schedule
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );

/**
 * The Roadmap: zoom, Today and ‹ › over the lanes and the timeline, where
 * each scheduled task draws a bar from its start to its due date (a subtask
 * with no start draws a milestone), late days marked past the due date and
 * today ruled across. Unscheduled tasks wait in the tray below.
 */
export function renderRoadmap(props: RoadmapRenderProps): ReactNode {
  return (
    <div className={roadmapClass}>
      {controls(props)}
      {props.notice === null ? null : (
        <p role="status" className={roadmapNoticeClass}>
          {props.notice}
        </p>
      )}
      {props.rows.length === 0 ? (
        <p className={roadmapEmptyClass}>Nothing scheduled yet.</p>
      ) : (
        <div className={roadmapGridClass}>
          {lanes(props)}
          {timeline(props)}
        </div>
      )}
      {tray(props)}
    </div>
  );
}
