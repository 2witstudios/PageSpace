'use client';

import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { format, isTomorrow, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';
import { Calendar, MapPin, Plus, Zap } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  CalendarEvent,
  CalendarHandlers,
  TaskWithDueDate,
  EventColorConfig,
  getEventsForDay,
  getTasksForDay,
  resolveEventColor,
  TASK_OVERLAY_STYLE,
  isSameDay,
  isToday,
} from './calendar-types';

/** Imperative surface the parent uses to drive the agenda from the date strip. */
export interface MobileAgendaHandle {
  /**
   * Returns false when the day is not on screen to scroll to -- the agenda is
   * unmounted behind a loading spinner, or the day is not in the window. The
   * caller keeps the request and retries rather than dropping it.
   */
  scrollToDate: (date: Date, behavior?: ScrollBehavior) => boolean;
}

interface MobileAgendaProps {
  /** Every day the loaded window covers, ascending. */
  days: Date[];
  selectedDate: Date;
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  handlers: CalendarHandlers;
  showTasks: boolean;
  onCreateEvent: () => void;
  /**
   * A day the user picked outright, kept in the list even when empty so the pick
   * visibly lands. Deliberately not `selectedDate`: scroll-sync moves that on
   * every day boundary, and inserting a section mid-gesture shifts the scroll.
   */
  pinnedDate: Date | null;
  /** Fired when scrolling brings a different day to the top of the list. */
  onVisibleDateChange: (date: Date) => void;
  showGoogleCalendarHint?: boolean;
  driveColorMap?: Map<string | null, EventColorConfig> | null;
  context?: 'user' | 'drive';
}

interface AgendaDay {
  date: Date;
  key: string;
  /** All-day events, plus timed events that span more than one day. */
  banner: CalendarEvent[];
  /** Events that start and end on this day, in start order. */
  timed: CalendarEvent[];
  tasks: TaskWithDueDate[];
}

const dayKey = (date: Date) => format(date, 'yyyy-MM-dd');

const byStart = (a: CalendarEvent, b: CalendarEvent) =>
  new Date(a.startAt).getTime() - new Date(b.startAt).getTime();

/**
 * A timed event running across a day boundary has no meaningful start or end
 * *on* the days it merely passes through -- printing its absolute times in each
 * day's gutter reads as a different event repeated. It goes in the banner band
 * with the all-day events instead, which is where every other calendar puts it.
 */
const spansDays = (event: CalendarEvent) =>
  event.allDay || !isSameDay(new Date(event.startAt), new Date(event.endAt));

function relativeLabel(date: Date): string | null {
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  if (isYesterday(date)) return 'Yesterday';
  return null;
}

/**
 * One scroller across the whole loaded window, with sticky day headers, rather
 * than a separate list per day. An empty day costs a single line instead of a
 * full-screen dead end, and there is exactly one scroll container to get right.
 */
export const MobileAgenda = forwardRef<MobileAgendaHandle, MobileAgendaProps>(
  function MobileAgenda(
    {
      days,
      selectedDate,
      pinnedDate,
      events,
      tasks,
      handlers,
      showTasks,
      onCreateEvent,
      onVisibleDateChange,
      showGoogleCalendarHint = true,
      driveColorMap,
      context = 'drive',
    },
    ref
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const dayRefs = useRef(new Map<string, HTMLElement>());

    // Only used to place the current-time marker; a minute's resolution is plenty.
    const [now, setNow] = useState(() => new Date());
    const windowHasToday = useMemo(() => days.some(isToday), [days]);
    useEffect(() => {
      // No marker to move when the window is another month -- don't re-render
      // the whole agenda every minute for nothing.
      if (!windowHasToday) return;
      const id = setInterval(() => setNow(new Date()), 60_000);
      return () => clearInterval(id);
    }, [windowHasToday]);

    const groups = useMemo<AgendaDay[]>(() => {
      return days
        .map((date) => {
          const dayStart = new Date(date);
          dayStart.setHours(0, 0, 0, 0);
          const dayEvents = getEventsForDay(events, date).filter(
            // getEventsForDay matches on `end >= dayStart`, so a timed event
            // ending exactly at midnight also matches the following day. It has
            // no presence there -- and as a banner chip it would read as an
            // all-day event the next morning.
            (event) => event.allDay || new Date(event.endAt).getTime() > dayStart.getTime()
          );
          return {
            date,
            key: dayKey(date),
            banner: dayEvents.filter(spansDays),
            timed: dayEvents.filter((event) => !spansDays(event)).sort(byStart),
            tasks: showTasks ? getTasksForDay(tasks, date) : [],
          };
        })
        .filter(
          (group) =>
            group.banner.length > 0 ||
            group.timed.length > 0 ||
            group.tasks.length > 0 ||
            // Keep a picked day even when empty, so the pick visibly lands.
            (pinnedDate !== null && isSameDay(group.date, pinnedDate))
        );
    }, [days, events, tasks, showTasks, pinnedDate]);

    const hasContent = groups.some(
      (group) => group.banner.length > 0 || group.timed.length > 0 || group.tasks.length > 0
    );
    // Name the window, not the scrolled date: scroll-sync can carry selectedDate
    // into an adjacent month. The middle of the range is always in the window's
    // own month, since the range is that month plus partial weeks either side.
    const windowMonth = days.length > 0 ? days[Math.floor(days.length / 2)] : selectedDate;

    const registerDay = useCallback((key: string, node: HTMLElement | null) => {
      if (node) dayRefs.current.set(key, node);
      else dayRefs.current.delete(key);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        scrollToDate: (date: Date, behavior: ScrollBehavior = 'smooth') => {
          const scroller = scrollRef.current;
          const node = dayRefs.current.get(dayKey(date));
          if (!scroller || !node) return false;
          // Measured, not offsetTop: the scroller is not the offsetParent.
          const delta =
            node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
          return true;
        },
      }),
      []
    );

    // Scrolling past a day boundary moves the strip's selection to match.
    const frame = useRef<number | null>(null);
    const handleScroll = useCallback(() => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const scroller = scrollRef.current;
        if (!scroller) return;
        const top = scroller.getBoundingClientRect().top;
        let visible: AgendaDay | null = null;
        for (const group of groups) {
          const node = dayRefs.current.get(group.key);
          if (!node) continue;
          // The topmost header that has not yet scrolled past the top edge.
          if (node.getBoundingClientRect().top - top <= 1) visible = group;
          else break;
        }
        if (visible && !isSameDay(visible.date, selectedDate)) {
          onVisibleDateChange(visible.date);
        }
      });
    }, [groups, selectedDate, onVisibleDateChange]);

    useEffect(() => {
      return () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
      };
    }, []);

    return (
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      >
        {groups.map((group) => (
          <AgendaDaySection
            key={group.key}
            group={group}
            now={now}
            handlers={handlers}
            driveColorMap={driveColorMap}
            context={context}
            registerDay={registerDay}
          />
        ))}

        {/* An empty window keeps the pinned day above rather than replacing the
            list wholesale: the pick stays visible, and scrollToDate can still
            succeed instead of leaving the request pending forever. */}
        {!hasContent && (
          <div className="flex flex-col items-center px-8 py-10 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <Calendar className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mb-1 text-lg font-medium">Nothing scheduled</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              {format(windowMonth, 'MMMM yyyy')} is empty
            </p>
            <Button variant="outline" size="sm" onClick={onCreateEvent}>
              <Plus className="mr-1 h-4 w-4" />
              Create Event
            </Button>
            {showGoogleCalendarHint && (
              <Link
                href="/settings/integrations/google-calendar"
                className="mt-6 flex items-center gap-1.5 text-sm text-muted-foreground/70 transition-colors hover:text-primary"
              >
                <Calendar className="h-4 w-4" />
                Import from Google Calendar
              </Link>
            )}
          </div>
        )}

        {/* Clearance so the last row can sit above the create button. */}
        <div className="h-20" aria-hidden="true" />
      </div>
    );
  }
);

function AgendaDaySection({
  group,
  now,
  handlers,
  driveColorMap,
  context,
  registerDay,
}: {
  group: AgendaDay;
  now: Date;
  handlers: CalendarHandlers;
  driveColorMap?: Map<string | null, EventColorConfig> | null;
  context: 'user' | 'drive';
  registerDay: (key: string, node: HTMLElement | null) => void;
}) {
  const dayIsToday = isToday(group.date);
  const relative = relativeLabel(group.date);
  const isEmpty =
    group.banner.length === 0 && group.timed.length === 0 && group.tasks.length === 0;

  // The marker goes before the first event that has not started yet.
  const nowIndex = dayIsToday
    ? group.timed.findIndex((event) => new Date(event.startAt) > now)
    : -1;

  return (
    <section
      aria-label={format(group.date, 'EEEE, MMMM d')}
      ref={(node) => {
        registerDay(group.key, node);
      }}
    >
      <h2
        className={cn(
          'sticky top-0 z-10 flex items-baseline gap-2 border-t bg-muted/60 px-3.5 py-1 text-[11px] font-bold uppercase tracking-wider backdrop-blur-sm',
          dayIsToday ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        <span className="tabular-nums">{format(group.date, 'EEE d')}</span>
        {relative && (
          <span className="ml-auto text-[11px] font-medium normal-case tracking-normal text-muted-foreground">
            {relative}
          </span>
        )}
      </h2>

      {group.banner.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3.5 pt-1.5 pb-0.5">
          {group.banner.map((event) => {
            const colors = resolveEventColor(event, context, driveColorMap ?? null);
            return (
              <button
                key={`${event.id}-${event.startAt}`}
                onClick={() => handlers.onEventClick(event)}
                className={cn(
                  'max-w-full truncate rounded border-l-[3px] px-2 py-0.5 text-left text-xs font-medium leading-5 active:opacity-70',
                  colors.bg,
                  colors.border
                )}
              >
                {event.title}
              </button>
            );
          })}
        </div>
      )}

      {group.timed.map((event, index) => (
        <Fragment key={`${event.id}-${event.startAt}`}>
          {index === nowIndex && <NowMarker now={now} />}
          <AgendaEventRow
            event={event}
            colors={resolveEventColor(event, context, driveColorMap ?? null)}
            onClick={() => handlers.onEventClick(event)}
          />
        </Fragment>
      ))}
      {nowIndex === -1 && dayIsToday && group.timed.length > 0 && <NowMarker now={now} />}

      {group.tasks.map((task) => (
        <AgendaTaskRow key={task.id} task={task} onClick={() => handlers.onTaskClick?.(task)} />
      ))}

      {isEmpty && (
        <p className="px-3.5 py-2 pl-[78px] text-[13px] italic text-muted-foreground">
          Nothing scheduled
        </p>
      )}
    </section>
  );
}

function NowMarker({ now }: { now: Date }) {
  return (
    <div className="flex items-center px-3.5" aria-hidden="true">
      <span className="w-16 shrink-0 pr-2 text-right text-[11px] font-bold tabular-nums whitespace-nowrap text-destructive">
        {format(now, 'h:mm a')}
      </span>
      <span className="relative h-px flex-1 bg-destructive">
        <span className="absolute -left-px -top-[3px] block h-[7px] w-[7px] rounded-full bg-destructive" />
      </span>
    </div>
  );
}

/**
 * A time gutter, a colour rail and one title line. Description, the attendee
 * stack, RSVP counts and the drive badge live in EventModal, one tap away --
 * printing them eleven times on one screen is what cost the density.
 */
function AgendaEventRow({
  event,
  colors,
  onClick,
}: {
  event: CalendarEvent;
  colors: EventColorConfig;
  onClick: () => void;
}) {
  const secondary = [
    event.location,
    event.attendees.length > 0 ? `${event.attendees.length} guests` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button
      onClick={onClick}
      className="flex w-full items-stretch border-b border-border/40 px-3.5 text-left active:bg-muted/50"
    >
      <span className="flex w-16 shrink-0 flex-col justify-start py-2 pr-2 text-right tabular-nums whitespace-nowrap">
        <span className="text-[12px] font-medium leading-4">
          {format(new Date(event.startAt), 'h:mm a')}
        </span>
        <span className="text-[11px] leading-4 text-muted-foreground">
          {format(new Date(event.endAt), 'h:mm a')}
        </span>
      </span>
      <span className={cn('my-2 w-[3px] shrink-0 rounded-full', colors.dot)} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 pl-2.5">
        <span className="truncate text-sm font-medium leading-5">
          {event.hasAgentTrigger && (
            <>
              <Zap
                className="mr-1 inline-block h-3.5 w-3.5 align-text-top text-amber-500"
                aria-hidden="true"
              />
              <span className="sr-only">Agent trigger configured. </span>
            </>
          )}
          {event.title}
        </span>
        {secondary && (
          <span className="flex items-center gap-1 truncate text-xs leading-4 text-muted-foreground">
            {event.location && <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span className="truncate">{secondary}</span>
          </span>
        )}
      </span>
    </button>
  );
}

function AgendaTaskRow({ task, onClick }: { task: TaskWithDueDate; onClick: () => void }) {
  const isCompleted = task.status === 'completed';
  const priorityColors = {
    low: 'text-muted-foreground',
    medium: 'text-amber-600',
    high: 'text-red-600',
  };

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-stretch border-b border-border/40 px-3.5 text-left active:bg-muted/50',
        isCompleted && 'opacity-60'
      )}
    >
      <span className="flex w-16 shrink-0 flex-col justify-start py-2 pr-2 text-right tabular-nums whitespace-nowrap">
        <span className="text-[12px] font-medium leading-4">
          {format(new Date(task.dueDate), 'h:mm a')}
        </span>
        <span className="text-[11px] leading-4 text-muted-foreground">due</span>
      </span>
      <span className={cn('my-2 w-[3px] shrink-0 rounded-full', TASK_OVERLAY_STYLE.dot)} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 pl-2.5">
        <span className="flex items-center gap-1.5 truncate text-sm font-medium leading-5">
          <span
            className={cn(
              'inline-grid h-3.5 w-3.5 shrink-0 place-items-center rounded border-[1.5px]',
              isCompleted
                ? 'border-green-500 bg-green-500 text-white'
                : 'border-muted-foreground'
            )}
            aria-hidden="true"
          >
            {isCompleted && <span className="text-[9px] leading-none">✓</span>}
          </span>
          <span className={cn('truncate', isCompleted && 'line-through text-muted-foreground')}>
            {task.title}
          </span>
        </span>
        <span className="truncate text-xs leading-4 text-muted-foreground">
          <span className="capitalize">{task.status.replace('_', ' ')}</span>
          {' · '}
          <span className={cn('capitalize', priorityColors[task.priority])}>{task.priority}</span>
        </span>
      </span>
    </button>
  );
}
