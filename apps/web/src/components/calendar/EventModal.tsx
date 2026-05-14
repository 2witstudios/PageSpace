'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { format } from 'date-fns';
import { AlertCircle, Bot, CalendarIcon, Check, ChevronRight, CircleHelp, Clock, MapPin, Trash2, UserPlus, X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import useSWR from 'swr';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useEditingSession } from '@/stores/useEditingSession';
import { useAuthStore } from '@/stores/useAuthStore';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { AttendeeStatus, CalendarEvent, CalendarEventAttendee, RecurrenceRule, ATTENDEE_STATUS_CONFIG, EVENT_COLORS } from './calendar-types';
import { TriggerPagePicker } from '@/components/layout/middle-content/page-views/task-list/TriggerPagePicker';
import {
  AgentTriggerSection,
  type AgentTriggerValue,
  type AgentTriggerAgent,
} from '@/components/agent-triggers/AgentTriggerSection';

export type AgentTriggerSavePayload = {
  agentPageId: string;
  prompt?: string;
  instructionPageId: string | null;
  contextPageIds: string[];
};

interface AssigneesResponse {
  assignees: Array<{ id: string; type: 'user' | 'agent'; name: string | null; image: string | null }>;
}

const assigneesFetcher = async (url: string): Promise<AssigneesResponse> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to load assignees');
  return res.json();
};

interface AttendeeComboboxProps {
  users: Array<{ id: string; name: string | null; image: string | null }>;
  onAdd: (userId: string) => void;
}

function AttendeeCombobox({ users, onAdd }: AttendeeComboboxProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full justify-start text-muted-foreground">
          <UserPlus className="h-4 w-4 mr-2" />
          Add attendee
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search members…" />
          <CommandList>
            <CommandEmpty>No members found</CommandEmpty>
            <CommandGroup>
              {users.map((user) => (
                <CommandItem
                  key={user.id}
                  value={user.name ?? user.id}
                  onSelect={() => {
                    onAdd(user.id);
                    setOpen(false);
                  }}
                >
                  <Avatar className="h-5 w-5 mr-2">
                    {user.image && <AvatarImage src={user.image} />}
                    <AvatarFallback className="text-xs">{(user.name ?? '?')[0].toUpperCase()}</AvatarFallback>
                  </Avatar>
                  {user.name ?? user.id}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface EventModalProps {
  isOpen: boolean;
  onClose: () => void;
  event: CalendarEvent | null;
  defaultValues: {
    startAt: Date;
    endAt: Date;
    allDay: boolean;
  } | null;
  onSave: (eventData: {
    title: string;
    description?: string;
    location?: string;
    startAt: Date;
    endAt: Date;
    allDay: boolean;
    color?: string;
    attendeeIds?: string[];
    pageId?: string | null;
    agentTrigger?: AgentTriggerSavePayload | null;
    recurrenceRule?: RecurrenceRule | null;
  }) => Promise<void>;
  onDelete?: () => Promise<void>;
  onRsvp?: (status: AttendeeStatus) => Promise<void>;
  onAddAttendee?: (userId: string) => Promise<void>;
  onRemoveAttendee?: (userId: string) => Promise<void>;
  driveId?: string;
  context: 'user' | 'drive';
}

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const hours = Math.floor(i / 2);
  const minutes = i % 2 === 0 ? '00' : '30';
  const period = hours < 12 ? 'AM' : 'PM';
  const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return {
    value: `${hours.toString().padStart(2, '0')}:${minutes}`,
    label: `${displayHours}:${minutes} ${period}`,
  };
});

const COLOR_OPTIONS = Object.keys(EVENT_COLORS) as (keyof typeof EVENT_COLORS)[];

interface EventTriggerRow {
  id: string;
  agentPageId: string;
  prompt: string | null;
  instructionPageId: string | null;
  contextPageIds: string[] | null;
  lastFiredAt: string | null;
  lastFireError: string | null;
}

type LastRunStatus = 'never_run' | 'success' | 'error';

const lastRunStatusFor = (row: EventTriggerRow): LastRunStatus => {
  if (row.lastFiredAt === null) return 'never_run';
  if (row.lastFireError) return 'error';
  return 'success';
};

const EMPTY_AGENT_VALUE: AgentTriggerValue = {
  agentPageId: '',
  prompt: '',
  instructionPageId: null,
  contextPageIds: [],
};

const triggerFetcher = async (url: string): Promise<{ trigger: EventTriggerRow | null }> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to load trigger');
  return res.json();
};

const agentsFetcher = async (url: string): Promise<{ agents: AgentTriggerAgent[] }> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to load agents');
  return res.json();
};

export function EventModal({
  isOpen,
  onClose,
  event,
  defaultValues,
  onSave,
  onDelete,
  onRsvp,
  onAddAttendee,
  onRemoveAttendee,
  driveId,
  context,
}: EventModalProps) {
  const isEditing = !!event;
  const isDriveContext = context === 'drive' && !!driveId;
  // Agent triggers attach to drive events only — the executor needs a drive
  // context to resolve agent / instruction / context pages.
  const showAgentSection = isDriveContext;

  // Form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [linkedPageId, setLinkedPageId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState<Date>(new Date());
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState<Date>(new Date());
  const [endTime, setEndTime] = useState('10:00');
  const [allDay, setAllDay] = useState(false);
  const [color, setColor] = useState<keyof typeof EVENT_COLORS>('default');
  const [isSaving, setIsSaving] = useState(false);
  const [rsvpLoading, setRsvpLoading] = useState(false);

  const currentUserId = useAuthStore((s) => s.user?.id);
  const myAttendee = useMemo(
    () => event?.attendees.find((a) => a.userId === currentUserId && !a.isOrganizer) ?? null,
    [event, currentUserId],
  );

  const handleRsvp = async (status: AttendeeStatus) => {
    if (!onRsvp) return;
    setRsvpLoading(true);
    try {
      await onRsvp(status);
      toast.success('RSVP updated');
    } catch {
      toast.error('Failed to update RSVP');
    } finally {
      setRsvpLoading(false);
    }
  };

  // Attendee state (pending list for new events)
  const [pendingAttendees, setPendingAttendees] = useState<CalendarEventAttendee[]>([]);

  // Recurrence state
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<RecurrenceRule['frequency'] | 'NONE'>('NONE');
  const [recurrenceInterval, setRecurrenceInterval] = useState(1);
  const [recurrenceByDay, setRecurrenceByDay] = useState<NonNullable<RecurrenceRule['byDay']>>([]);
  const [recurrenceEndType, setRecurrenceEndType] = useState<'never' | 'count' | 'until'>('never');
  const [recurrenceCount, setRecurrenceCount] = useState(10);
  const [recurrenceUntil, setRecurrenceUntil] = useState<Date | null>(null);
  const [recurrenceExpanded, setRecurrenceExpanded] = useState(false);

  // Agent trigger state
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [agentValue, setAgentValue] = useState<AgentTriggerValue>(EMPTY_AGENT_VALUE);
  const [agentExpanded, setAgentExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  // Pause SWR while the modal is open so a remote calendar broadcast can't
  // clobber unsaved typing in the form (mirrors the dialog's prior behavior).
  useEditingSession(`event-modal:${event?.id ?? 'new'}`, isOpen, 'form', {
    pageId: event?.id,
    componentName: 'EventModal',
  });

  const isAnyActive = useEditingStore((s) => s.isAnyActive());
  const triggerLoadedRef = useRef(false);
  const agentsLoadedRef = useRef(false);

  // Fetch the existing trigger when editing a saved drive event. New events
  // (no eventId yet) start from the empty value; the agent trigger is sent
  // in the same POST that creates the event.
  const triggerKey =
    isOpen && showAgentSection && isEditing && event ? `/api/calendar/events/${event.id}/triggers` : null;
  const agentsKey =
    isOpen && showAgentSection && driveId ? `/api/drives/${driveId}/agents` : null;

  const { data: triggerData, isLoading: triggerLoading } = useSWR(
    triggerKey,
    triggerFetcher,
    {
      revalidateOnFocus: false,
      isPaused: () => triggerLoadedRef.current && isAnyActive,
      onSuccess: () => {
        triggerLoadedRef.current = true;
      },
    },
  );

  const { data: agentsData, isLoading: agentsLoading } = useSWR(
    agentsKey,
    agentsFetcher,
    {
      revalidateOnFocus: false,
      isPaused: () => agentsLoadedRef.current && isAnyActive,
      onSuccess: () => {
        agentsLoadedRef.current = true;
      },
    },
  );

  const agents = useMemo(() => agentsData?.agents ?? [], [agentsData]);
  const noAgents = !agentsLoading && agents.length === 0;

  // Attendees make sense whenever the event has a drive association. Derive from the event
  // itself when editing so the section works even in user-context CalendarView.
  const effectiveDriveId = event?.driveId ?? driveId;
  const showAttendeesSection = !!effectiveDriveId;

  const assigneesKey = isOpen && showAttendeesSection ? `/api/drives/${effectiveDriveId}/assignees` : null;
  const { data: assigneesData } = useSWR<AssigneesResponse>(assigneesKey, assigneesFetcher, {
    revalidateOnFocus: false,
  });
  const driveUsers = useMemo(
    () => (assigneesData?.assignees ?? []).filter((a) => a.type === 'user'),
    [assigneesData]
  );
  const existingTrigger = triggerData?.trigger ?? null;
  const existingStatus: LastRunStatus | null = existingTrigger
    ? lastRunStatusFor(existingTrigger)
    : null;

  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen) {
      if (event) {
        setTitle(event.title);
        setDescription(event.description ?? '');
        setLocation(event.location ?? '');
        setLinkedPageId(event.pageId ?? null);
        setAllDay(event.allDay);
        setColor(event.color as keyof typeof EVENT_COLORS);

        // For virtual recurring occurrences, use the parent's base start/end
        // so saving doesn't accidentally shift the series anchor date.
        const start = new Date(event.recurringBaseStartAt ?? event.startAt);
        const end = event.recurringBaseStartAt
          ? new Date(start.getTime() + (new Date(event.endAt).getTime() - new Date(event.startAt).getTime()))
          : new Date(event.endAt);
        setStartDate(start);
        setEndDate(end);
        setStartTime(format(start, 'HH:mm'));
        setEndTime(format(end, 'HH:mm'));
      } else if (defaultValues) {
        setTitle('');
        setDescription('');
        setLocation('');
        setLinkedPageId(null);
        setAllDay(defaultValues.allDay);
        setColor('default');
        setStartDate(defaultValues.startAt);
        setEndDate(defaultValues.endAt);
        setStartTime(format(defaultValues.startAt, 'HH:mm'));
        setEndTime(format(defaultValues.endAt, 'HH:mm'));
      } else {
        const now = new Date();
        const start = new Date(now);
        start.setMinutes(0, 0, 0);
        start.setHours(start.getHours() + 1);
        const end = new Date(start);
        end.setHours(end.getHours() + 1);

        setTitle('');
        setDescription('');
        setLocation('');
        setLinkedPageId(null);
        setAllDay(false);
        setColor('default');
        setStartDate(start);
        setEndDate(end);
        setStartTime(format(start, 'HH:mm'));
        setEndTime(format(end, 'HH:mm'));
      }
      // Hydrate recurrence state
      const rule = event?.recurrenceRule ?? null;
      if (rule) {
        setRecurrenceFrequency(rule.frequency);
        setRecurrenceInterval(rule.interval ?? 1);
        setRecurrenceByDay(rule.byDay ?? []);
        if (rule.count) {
          setRecurrenceEndType('count');
          setRecurrenceCount(rule.count);
        } else if (rule.until) {
          setRecurrenceEndType('until');
          setRecurrenceUntil(new Date(rule.until));
        } else {
          setRecurrenceEndType('never');
        }
      } else {
        setRecurrenceFrequency('NONE');
        setRecurrenceInterval(1);
        setRecurrenceByDay([]);
        setRecurrenceEndType('never');
        setRecurrenceCount(10);
        setRecurrenceUntil(null);
      }

      setAdvancedExpanded(false);
      setAgentExpanded(false);
      setRecurrenceExpanded(false);
      setPendingAttendees([]);
    } else {
      triggerLoadedRef.current = false;
      agentsLoadedRef.current = false;
    }
  }, [isOpen, event, defaultValues]);

  // Hydrate agent state once the trigger fetch lands (or reset if there's no
  // trigger / no eventId yet).
  useEffect(() => {
    if (!isOpen) return;
    if (existingTrigger) {
      setAgentEnabled(true);
      setAgentValue({
        agentPageId: existingTrigger.agentPageId,
        prompt: existingTrigger.prompt ?? '',
        instructionPageId: existingTrigger.instructionPageId,
        contextPageIds: existingTrigger.contextPageIds ?? [],
      });
    } else if (!triggerKey || (!triggerLoading && triggerData)) {
      // No fetch (new event) OR fetch landed with no trigger row → reset to empty.
      setAgentEnabled(false);
      setAgentValue(EMPTY_AGENT_VALUE);
    }
  }, [isOpen, existingTrigger, triggerKey, triggerLoading, triggerData]);

  const selectedAgentName = useMemo(() => {
    if (!agentEnabled) return null;
    const found = agents.find((a) => a.id === agentValue.agentPageId);
    return found?.title ?? null;
  }, [agentEnabled, agents, agentValue.agentPageId]);

  const isCreator = !event || event.createdById === currentUserId;
  const shownAttendees = (event?.attendees ?? pendingAttendees).filter((a) => !a.isOrganizer);
  const existingAttendeeUserIds = event
    ? event.attendees.map((a) => a.userId)
    : pendingAttendees.map((a) => a.userId);
  const availableUsers = driveUsers.filter((u) => !existingAttendeeUserIds.includes(u.id));

  const handleAddAttendee = async (userId: string) => {
    if (event) {
      try {
        await onAddAttendee?.(userId);
      } catch {
        toast.error('Failed to add attendee');
      }
    } else {
      const member = driveUsers.find((u) => u.id === userId);
      setPendingAttendees((prev) => {
        if (prev.some((a) => a.userId === userId)) return prev;
        return [
          ...prev,
          {
            id: userId,
            eventId: '',
            userId,
            status: 'PENDING' as const,
            responseNote: null,
            isOrganizer: false,
            isOptional: false,
            invitedAt: new Date().toISOString(),
            respondedAt: null,
            user: { id: userId, name: member?.name ?? null, image: member?.image ?? null },
          },
        ];
      });
    }
  };

  const handleRemoveAttendee = async (userId: string) => {
    if (event) {
      try {
        await onRemoveAttendee?.(userId);
      } catch {
        toast.error('Failed to remove attendee');
      }
    } else {
      setPendingAttendees((prev) => prev.filter((a) => a.userId !== userId));
    }
  };

  const buildDateTime = (date: Date, time: string): Date => {
    const [hours, minutes] = time.split(':').map(Number);
    const result = new Date(date);
    result.setHours(hours, minutes, 0, 0);
    return result;
  };

  const handleSave = async () => {
    if (!title.trim()) {
      toast.error('Please enter a title');
      return;
    }

    const startAt = allDay
      ? (() => { const d = new Date(startDate); d.setHours(0, 0, 0, 0); return d; })()
      : buildDateTime(startDate, startTime);
    const endAt = allDay
      ? (() => { const d = new Date(endDate); d.setHours(23, 59, 59, 999); return d; })()
      : buildDateTime(endDate, endTime);

    if (endAt <= startAt) {
      toast.error('End time must be after start time');
      return;
    }

    let agentTrigger: AgentTriggerSavePayload | null | undefined;
    if (showAgentSection) {
      if (agentEnabled) {
        if (!agentValue.agentPageId) {
          toast.error('Pick an agent for the trigger');
          return;
        }
        if (!agentValue.prompt.trim() && !agentValue.instructionPageId) {
          toast.error('Enter a prompt or pick an instruction page');
          return;
        }
        agentTrigger = {
          agentPageId: agentValue.agentPageId,
          prompt: agentValue.prompt.trim() || undefined,
          instructionPageId: agentValue.instructionPageId,
          contextPageIds: agentValue.contextPageIds,
        };
      } else if (existingTrigger) {
        // Was enabled, user turned it off → remove.
        agentTrigger = null;
      }
      // else: undefined → no-op (no trigger before, none now)
    }

    const recurrenceRule: RecurrenceRule | null =
      recurrenceFrequency === 'NONE'
        ? null
        : {
            frequency: recurrenceFrequency,
            interval: recurrenceInterval,
            ...(recurrenceFrequency === 'WEEKLY' && recurrenceByDay.length > 0
              ? { byDay: recurrenceByDay }
              : {}),
            ...(recurrenceFrequency === 'MONTHLY'
              ? { byMonthDay: [startAt.getDate()] }
              : {}),
            ...(recurrenceEndType === 'count'
              ? { count: recurrenceCount }
              : recurrenceEndType === 'until' && recurrenceUntil
              ? { until: recurrenceUntil.toISOString().slice(0, 10) }
              : {}),
          };

    setIsSaving(true);
    try {
      await onSave({
        title: title.trim(),
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        startAt,
        endAt,
        allDay,
        color,
        pageId: isDriveContext ? linkedPageId : undefined,
        agentTrigger,
        recurrenceRule,
        attendeeIds: !event && pendingAttendees.length > 0
          ? pendingAttendees.map((a) => a.userId)
          : undefined,
      });
      toast.success(isEditing ? 'Event updated' : 'Event created');
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to save event'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;

    setIsSaving(true);
    try {
      await onDelete();
      toast.success('Event deleted');
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to delete event'
      );
    } finally {
      setIsSaving(false);
    }
  };

  let agentHeaderLabel: string;
  if (!agentEnabled) agentHeaderLabel = 'Off';
  else if (selectedAgentName) agentHeaderLabel = `${selectedAgentName} at start`;
  else agentHeaderLabel = 'On';

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Event' : 'New Event'}</DialogTitle>
          <DialogDescription className="sr-only">
            Configure the event title, schedule, location, and optional agent trigger.
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={isSaving || rsvpLoading}>
          <div className="space-y-4 py-4">
            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                placeholder="Event title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </div>

            {myAttendee && onRsvp && (
              <div className="space-y-2 rounded-md border p-3">
                <Label className="text-sm font-medium">Your RSVP</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={myAttendee.status === 'ACCEPTED' ? 'default' : 'outline'}
                    onClick={() => handleRsvp('ACCEPTED')}
                  >
                    <Check className="h-3.5 w-3.5 mr-1.5" />
                    Accept
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={myAttendee.status === 'TENTATIVE' ? 'secondary' : 'outline'}
                    onClick={() => handleRsvp('TENTATIVE')}
                  >
                    <CircleHelp className="h-3.5 w-3.5 mr-1.5" />
                    Maybe
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={myAttendee.status === 'DECLINED' ? 'destructive' : 'outline'}
                    onClick={() => handleRsvp('DECLINED')}
                  >
                    <X className="h-3.5 w-3.5 mr-1.5" />
                    Decline
                  </Button>
                </div>
              </div>
            )}

          {/* All-day toggle */}
          <div className="flex items-center justify-between">
            <Label htmlFor="all-day" className="cursor-pointer">
              All day
            </Label>
            <Switch
              id="all-day"
              checked={allDay}
              onCheckedChange={setAllDay}
            />
          </div>

          {/* Start date/time */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Start date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(startDate, 'MMM d, yyyy')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={startDate}
                    onSelect={(date) => date && setStartDate(date)}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {!allDay && (
              <div className="space-y-2">
                <Label>Start time</Label>
                <Select value={startTime} onValueChange={setStartTime}>
                  <SelectTrigger>
                    <Clock className="mr-2 h-4 w-4" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* End date/time */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>End date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(endDate, 'MMM d, yyyy')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={endDate}
                    onSelect={(date) => date && setEndDate(date)}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {!allDay && (
              <div className="space-y-2">
                <Label>End time</Label>
                <Select value={endTime} onValueChange={setEndTime}>
                  <SelectTrigger>
                    <Clock className="mr-2 h-4 w-4" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Location */}
          <div className="space-y-2">
            <Label htmlFor="location">Location</Label>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="location"
                placeholder="Add location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {/* Color */}
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex gap-2">
              {COLOR_OPTIONS.map((colorKey) => {
                const colorConfig = EVENT_COLORS[colorKey];
                return (
                  <button
                    key={colorKey}
                    className={cn(
                      'w-8 h-8 rounded-full transition-all',
                      colorConfig.dot,
                      color === colorKey
                        ? 'ring-2 ring-offset-2 ring-primary'
                        : 'hover:scale-110'
                    )}
                    onClick={() => setColor(colorKey)}
                    title={colorKey}
                  />
                );
              })}
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Add description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          {/* Repeat / recurrence */}
          <Collapsible open={recurrenceExpanded} onOpenChange={setRecurrenceExpanded}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between px-2 -mx-2"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <CalendarIcon className={cn('h-4 w-4', recurrenceFrequency !== 'NONE' ? 'text-primary' : 'text-muted-foreground')} />
                  Repeat
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {recurrenceFrequency === 'NONE'
                    ? 'Never'
                    : recurrenceFrequency === 'DAILY'
                    ? recurrenceInterval === 1 ? 'Every day' : `Every ${recurrenceInterval} days`
                    : recurrenceFrequency === 'WEEKLY'
                    ? (() => {
                        const days = recurrenceByDay.length > 0 ? recurrenceByDay.join(', ') : 'week';
                        return recurrenceInterval === 1 ? `Every week on ${days}` : `Every ${recurrenceInterval} weeks on ${days}`;
                      })()
                    : recurrenceFrequency === 'MONTHLY'
                    ? recurrenceInterval === 1 ? 'Every month' : `Every ${recurrenceInterval} months`
                    : recurrenceInterval === 1 ? 'Every year' : `Every ${recurrenceInterval} years`}
                  <ChevronRight className="h-3.5 w-3.5 transition-transform data-[state=open]:rotate-90" data-state={recurrenceExpanded ? 'open' : 'closed'} />
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              <div className="space-y-3 rounded-md border p-3">
                {/* Frequency */}
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Frequency</Label>
                  <Select value={recurrenceFrequency} onValueChange={(v) => setRecurrenceFrequency(v as typeof recurrenceFrequency)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">Never</SelectItem>
                      <SelectItem value="DAILY">Daily</SelectItem>
                      <SelectItem value="WEEKLY">Weekly</SelectItem>
                      <SelectItem value="MONTHLY">Monthly</SelectItem>
                      <SelectItem value="YEARLY">Yearly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {recurrenceFrequency !== 'NONE' && (
                  <>
                    {/* Interval */}
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground shrink-0">Every</Label>
                      <Input
                        type="number"
                        min={1}
                        max={99}
                        className="w-16 h-8 text-sm"
                        value={recurrenceInterval}
                        onChange={(e) => setRecurrenceInterval(Math.max(1, parseInt(e.target.value) || 1))}
                      />
                      <span className="text-sm text-muted-foreground">
                        {recurrenceFrequency === 'DAILY' ? 'day(s)' :
                         recurrenceFrequency === 'WEEKLY' ? 'week(s)' :
                         recurrenceFrequency === 'MONTHLY' ? 'month(s)' : 'year(s)'}
                      </span>
                    </div>

                    {/* Day-of-week picker for weekly */}
                    {recurrenceFrequency === 'WEEKLY' && (
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">On days</Label>
                        <div className="flex gap-1 flex-wrap">
                          {(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const).map((day) => (
                            <button
                              key={day}
                              type="button"
                              onClick={() =>
                                setRecurrenceByDay((prev) =>
                                  prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
                                )
                              }
                              className={cn(
                                'w-9 h-8 rounded text-xs font-medium transition-colors',
                                recurrenceByDay.includes(day)
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-muted text-muted-foreground hover:bg-muted/80',
                              )}
                            >
                              {day[0] + day[1].toLowerCase()}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* End type */}
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Ends</Label>
                      <Select value={recurrenceEndType} onValueChange={(v) => setRecurrenceEndType(v as typeof recurrenceEndType)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="never">Never</SelectItem>
                          <SelectItem value="count">After N occurrences</SelectItem>
                          <SelectItem value="until">On date</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {recurrenceEndType === 'count' && (
                      <div className="flex items-center gap-2">
                        <Label className="text-xs text-muted-foreground shrink-0">After</Label>
                        <Input
                          type="number"
                          min={1}
                          max={999}
                          className="w-20 h-8 text-sm"
                          value={recurrenceCount}
                          onChange={(e) => setRecurrenceCount(Math.max(1, parseInt(e.target.value) || 1))}
                        />
                        <span className="text-sm text-muted-foreground">occurrences</span>
                      </div>
                    )}

                    {recurrenceEndType === 'until' && (
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Until</Label>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="outline" className="w-full justify-start text-left font-normal h-8 text-sm">
                              <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                              {recurrenceUntil ? format(recurrenceUntil, 'MMM d, yyyy') : 'Pick a date'}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar
                              mode="single"
                              selected={recurrenceUntil ?? undefined}
                              onSelect={(date) => date && setRecurrenceUntil(date)}
                            />
                          </PopoverContent>
                        </Popover>
                      </div>
                    )}
                  </>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Attendees — drive events only (gate on actual driveId, not view context) */}
          {showAttendeesSection && (
            <div className="space-y-2 rounded-md border p-3">
              <Label className="text-sm font-medium">Attendees</Label>
              {shownAttendees.length > 0 && (
                <div className="space-y-1">
                  {shownAttendees.map((a) => (
                    <div key={a.userId} className="flex items-center justify-between gap-2 text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar className="h-5 w-5 shrink-0">
                          {a.user.image && <AvatarImage src={a.user.image} />}
                          <AvatarFallback className="text-xs">
                            {(a.user.name ?? '?')[0].toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="truncate">{a.user.name ?? a.userId}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge
                          variant="outline"
                          className={cn('text-xs', ATTENDEE_STATUS_CONFIG[a.status].color)}
                        >
                          {ATTENDEE_STATUS_CONFIG[a.status].label}
                        </Badge>
                        {isCreator && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5"
                            aria-label={`Remove ${a.user.name ?? a.userId}`}
                            onClick={() => handleRemoveAttendee(a.userId)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {isCreator && (
                <AttendeeCombobox
                  users={availableUsers}
                  onAdd={handleAddAttendee}
                />
              )}
            </div>
          )}

          {/* Agent trigger — collapsed by default; only meaningful for drive events.
              Status text reflects whether a trigger is configured so the modal
              reads as a normal calendar by default. */}
          {showAgentSection && (
            <Collapsible open={agentExpanded} onOpenChange={setAgentExpanded}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between px-2 -mx-2"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Zap className={cn('h-4 w-4', agentEnabled ? 'text-amber-500' : 'text-muted-foreground')} />
                    Agent trigger
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {agentHeaderLabel}
                    <ChevronRight className="h-3.5 w-3.5 transition-transform data-[state=open]:rotate-90" data-state={agentExpanded ? 'open' : 'closed'} />
                  </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                <div className="space-y-3 rounded-md border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                        <Label htmlFor="agent-trigger-enabled" className="font-medium cursor-pointer truncate">
                          Run agent at event start
                        </Label>
                      </div>
                      <Switch
                        id="agent-trigger-enabled"
                        checked={agentEnabled}
                        disabled={noAgents}
                        onCheckedChange={setAgentEnabled}
                      />
                    </div>

                    {noAgents && (
                      <p className="text-xs text-muted-foreground">
                        No agents in this drive. Create an AI Chat page first.
                      </p>
                    )}

                    {agentEnabled && !noAgents && driveId && (
                      <>
                        <AgentTriggerSection
                          driveId={driveId}
                          agents={agents}
                          agentsLoading={agentsLoading}
                          value={agentValue}
                          onChange={setAgentValue}
                          promptPlaceholder="What should the agent do when this event starts?"
                        />

                        {existingStatus && existingStatus !== 'never_run' && (
                          <p className={cn(
                            'text-xs',
                            existingStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
                          )}>
                            {existingStatus === 'error' && (
                              <AlertCircle className="h-3 w-3 inline mr-1" aria-hidden="true" />
                            )}
                            Last run: <span className="font-medium">{existingStatus}</span>
                            {existingTrigger?.lastFiredAt
                              ? ` • ${new Date(existingTrigger.lastFiredAt).toLocaleString()}`
                              : ''}
                          </p>
                        )}
                      </>
                    )}
                  </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Advanced — Linked page lives here so casual users see only normal
              calendar fields. Drive events only because the picker scopes to
              the drive's pages. */}
          {isDriveContext && driveId && (
            <Collapsible open={advancedExpanded} onOpenChange={setAdvancedExpanded}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 -ml-2 px-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight className="mr-1 h-3.5 w-3.5 transition-transform data-[state=open]:rotate-90" data-state={advancedExpanded ? 'open' : 'closed'} />
                  Advanced
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                <div className="space-y-2">
                  <Label>Linked page</Label>
                  <TriggerPagePicker
                    mode="single"
                    driveId={driveId}
                    value={linkedPageId}
                    onChange={setLinkedPageId}
                    placeholder="Pick a doc, sheet, or other page…"
                  />
                  <p className="text-xs text-muted-foreground">
                    Attach a doc, sheet, or other page to this event.
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
          </div>
        </fieldset>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {isEditing && onDelete && (
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isSaving}
              className="w-full sm:w-auto sm:mr-auto"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving...' : isEditing ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
