'use client';

// The Roadmap bound to a list's writes. Dragging a bar's edge or body, or an
// arrow key on an edge, is useTaskList's update: it shows at once, is saved
// through the imago client and rolls back if the server refuses it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { dueDateFor } from '../task-detail/due-date';
import type { Task, TaskList } from '../task-model/task';
import type { TaskPatch } from '../task-edit/task-edit';
import { browserStorage } from '../task-view/task-view';
import type { TaskActions } from '../use-tasks/use-tasks';
import {
  addDays,
  datesOf,
  dayDelta,
  dayWidths,
  defaultZoom,
  dragLabel,
  dragPatch,
  draggedDates,
  dragModeOf,
  headerOf,
  isPinned,
  keyDelta,
  periodDays,
  rangeOf,
  readZoom,
  roadmapRows,
  todayScroll,
  unscheduledTasks,
  writeZoom,
  type DragDates,
  type DragMode,
  type RoadmapRow,
  type Zoom,
} from './roadmap';
import { renderRoadmap, type RoadmapDragView } from './roadmap-view.render';

export type RoadmapViewProps = {
  /** The open list, already narrowed by the filter strip. */
  readonly list: TaskList;
  readonly actions: TaskActions;
  /** The viewer's own day, YYYY-MM-DD. */
  readonly today: string;
  /** Whether the viewer may change dates; read-only draws no handles. */
  readonly editable: boolean;
  /** Where a task opens; titles are plain text without it. */
  readonly taskHref?: (task: Task) => string;
};

/** A drag under way: what is held, from where, and how far it has gone. */
type Drag = {
  readonly row: RoadmapRow;
  readonly mode: DragMode;
  readonly originX: number;
  readonly before: DragDates;
  readonly delta: number;
  readonly pinned: boolean;
};

/**
 * The Roadmap: lanes on the left, the timeline on the right. The zoom is
 * kept per list in this browser; the drag in flight and the last refusal
 * are the view's own state, the tasks are useTaskList's.
 */
export function RoadmapView({ list, actions, today, editable, taskHref }: RoadmapViewProps): ReactNode {
  const [zoom, setZoomState] = useState<Zoom>(defaultZoom);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);

  const rows = useMemo(() => roadmapRows(list, today), [list, today]);
  const unscheduled = useMemo(() => unscheduledTasks(list), [list]);
  const range = useMemo(() => rangeOf(rows, today), [rows, today]);
  const header = useMemo(() => headerOf(range, zoom), [range, zoom]);
  const dayWidth = dayWidths[zoom];

  // The saved zoom follows once mounted, so the server render and the first
  // client render agree.
  useEffect(() => {
    setZoomState(readZoom(browserStorage(), list.pageId) ?? defaultZoom);
  }, [list.pageId]);

  const setZoom = (next: Zoom) => {
    setZoomState(next);
    writeZoom(browserStorage(), list.pageId, next);
  };

  const goToday = useCallback(() => {
    const element = timeline.current;
    if (element === null) return;
    element.scrollLeft = todayScroll(range, today, dayWidth, element.clientWidth);
  }, [range, today, dayWidth]);

  // Opening the Roadmap, or changing its zoom, brings today into view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(goToday, [zoom, list.pageId, rows.length === 0]);

  const step = (direction: -1 | 1) => {
    const element = timeline.current;
    if (element === null) return;
    element.scrollLeft += direction * periodDays[zoom] * dayWidth;
  };

  const save = (task: Task, patch: TaskPatch) => {
    void actions.update(task.id, patch).then((result) => setNotice(result.ok ? null : result.refusal));
  };

  const commit = (current: Drag) => {
    const after = draggedDates(current.before, current.mode, current.delta, current.pinned);
    const patch = dragPatch(current.row.mark, current.before, after, current.mode);
    if (patch !== null) save(current.row.task, patch);
  };

  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // While a drag is held, the window follows the pointer and listens for
  // Escape; the held element captures the pointer so nothing else sees it.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (event: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (current === null) return;
      const delta = dayDelta(event.clientX - current.originX, dayWidth);
      if (delta !== current.delta) update({ ...current, delta });
    };
    const end = () => {
      const current = dragRef.current;
      update(null);
      if (current !== null) commit(current);
    };
    const cancel = () => update(null);
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    };
    // commit reads the drag it is handed plus the save/actions of the render
    // the drag started in; that is safe because actions is memoized, so the
    // captured one stays current for the drag's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, dayWidth]);

  const startDrag = (row: RoadmapRow, mode: DragMode, event: PointerEvent<HTMLElement>) => {
    if (!editable || event.button !== 0) return;
    const before = datesOf(row.mark);
    if (before === null) return;
    event.preventDefault();
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the window still hears it.
    }
    update({ row, mode: dragModeOf(row.mark, mode), originX: event.clientX, before, delta: 0, pinned: isPinned(row) });
  };

  const nudge = (row: RoadmapRow, mode: DragMode, event: KeyboardEvent<HTMLElement>) => {
    const delta = keyDelta(event.key, event.shiftKey);
    const before = datesOf(row.mark);
    if (!editable || delta === 0 || before === null) return;
    event.preventDefault();
    commit({ row, mode: dragModeOf(row.mark, mode), originX: 0, before, delta, pinned: isPinned(row) });
  };

  const schedule = (task: Task) => save(task, { dueDate: dueDateFor(addDays(today, 7)) });

  const dragView: RoadmapDragView | null =
    drag === null
      ? null
      : (() => {
          const after = draggedDates(drag.before, drag.mode, drag.delta, drag.pinned);
          return { taskId: drag.row.task.id, dates: after, label: dragLabel(drag.before, after, drag.mode) };
        })();

  return renderRoadmap({
    label: `${list.title} roadmap`,
    zoom,
    setZoom,
    goToday,
    step,
    rows,
    unscheduled,
    range,
    header,
    today,
    editable,
    taskHref,
    timelineRef: timeline,
    drag: dragView,
    startDrag,
    nudge,
    schedule,
    notice,
  });
}
