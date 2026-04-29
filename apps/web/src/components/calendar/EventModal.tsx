'use client';

import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { Bot, CalendarIcon, Clock, MapPin, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
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
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { CalendarEvent, EVENT_COLORS } from './calendar-types';

interface DriveAgent {
  id: string;
  title: string | null;
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
    agentTrigger?: { agentPageId: string; prompt: string };
  }) => Promise<void>;
  onDelete?: () => Promise<void>;
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

export function EventModal({
  isOpen,
  onClose,
  event,
  defaultValues,
  onSave,
  onDelete,
  driveId,
  context,
}: EventModalProps) {
  const isEditing = !!event;
  const canScheduleAgent = context === 'drive' && !!driveId && !isEditing;

  // Form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [startDate, setStartDate] = useState<Date>(new Date());
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState<Date>(new Date());
  const [endTime, setEndTime] = useState('10:00');
  const [allDay, setAllDay] = useState(false);
  const [color, setColor] = useState<keyof typeof EVENT_COLORS>('default');
  const [isSaving, setIsSaving] = useState(false);

  // Agent scheduling state
  const [scheduleAgent, setScheduleAgent] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agents, setAgents] = useState<DriveAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen) {
      if (event) {
        setTitle(event.title);
        setDescription(event.description ?? '');
        setLocation(event.location ?? '');
        setAllDay(event.allDay);
        setColor(event.color as keyof typeof EVENT_COLORS);

        const start = new Date(event.startAt);
        const end = new Date(event.endAt);
        setStartDate(start);
        setEndDate(end);
        setStartTime(format(start, 'HH:mm'));
        setEndTime(format(end, 'HH:mm'));
      } else if (defaultValues) {
        setTitle('');
        setDescription('');
        setLocation('');
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
        setAllDay(false);
        setColor('default');
        setStartDate(start);
        setEndDate(end);
        setStartTime(format(start, 'HH:mm'));
        setEndTime(format(end, 'HH:mm'));
      }

      // Reset agent scheduling state
      setScheduleAgent(false);
      setSelectedAgentId('');
      setAgentPrompt('');
    }
  }, [isOpen, event, defaultValues]);

  // Fetch drive agents when modal opens in drive context
  useEffect(() => {
    if (!isOpen || !canScheduleAgent || !driveId) return;

    setAgentsLoading(true);
    fetchWithAuth(`/api/drives/${driveId}/agents`)
      .then(res => res.ok ? res.json() : Promise.reject())
      .then(data => setAgents(data.agents ?? []))
      .catch(() => setAgents([]))
      .finally(() => setAgentsLoading(false));
  }, [isOpen, canScheduleAgent, driveId]);

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

    if (scheduleAgent && (!selectedAgentId || selectedAgentId === '__none' || !agentPrompt.trim())) {
      toast.error('Please select an agent and enter a prompt');
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
        agentTrigger: scheduleAgent && selectedAgentId && agentPrompt.trim()
          ? { agentPageId: selectedAgentId, prompt: agentPrompt.trim() }
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

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Event' : 'New Event'}</DialogTitle>
        </DialogHeader>

        <fieldset disabled={isSaving}>
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

          {/* Agent scheduling (drive context, new events only) */}
          {canScheduleAgent && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="schedule-agent" className="cursor-pointer font-medium">
                    Run agent
                  </Label>
                </div>
                <Switch
                  id="schedule-agent"
                  checked={scheduleAgent}
                  onCheckedChange={setScheduleAgent}
                />
              </div>

              {scheduleAgent && (
                <div className="space-y-3 pt-1">
                  <div className="space-y-2">
                    <Label>Agent</Label>
                    <Select
                      value={selectedAgentId}
                      onValueChange={setSelectedAgentId}
                      disabled={agentsLoading}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={agentsLoading ? 'Loading agents…' : 'Select an agent'} />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.length === 0 && !agentsLoading && (
                          <SelectItem value="__none" disabled>
                            No agents in this drive
                          </SelectItem>
                        )}
                        {agents.map((agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            {agent.title ?? 'Untitled agent'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="agent-prompt">Prompt</Label>
                    <Textarea
                      id="agent-prompt"
                      placeholder="What should the agent do when this event starts?"
                      value={agentPrompt}
                      onChange={(e) => setAgentPrompt(e.target.value)}
                      rows={3}
                    />
                  </div>

                  <p className="text-xs text-muted-foreground">
                    The agent will run at the event&apos;s start time.
                  </p>
                </div>
              )}
            </div>
          )}

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
