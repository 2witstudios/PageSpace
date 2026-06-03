'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { CheckSquare, ChevronDown } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useDebounce } from '@/hooks/useDebounce';
import { useEditingStore } from '@/stores/useEditingStore';
import { cn } from '@/lib/utils';

interface DriveTask {
  id: string;
  title: string;
  taskListPageTitle?: string;
}

const tasksFetcher = async (url: string): Promise<DriveTask[]> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to search tasks');
  const json: unknown = await res.json();
  const tasks = (json as { tasks?: unknown })?.tasks;
  return Array.isArray(tasks) ? (tasks as DriveTask[]) : [];
};

interface TaskRelationPickerProps {
  driveId: string;
  /** Task ids to hide from results (self + already-related). */
  excludeIds?: string[];
  onSelect: (taskId: string, title: string) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
}

/**
 * Search tasks within a drive and pick one — used to choose a blocker or a task
 * to link into a list. Reuses the drive-scoped `/api/tasks` endpoint (search +
 * driveId) rather than a bespoke search route, mirroring TriggerPagePicker.
 */
export function TaskRelationPicker({
  driveId,
  excludeIds = [],
  onSelect,
  placeholder = 'Add a task…',
  label = 'Search tasks…',
  disabled,
}: TaskRelationPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 200);

  const isAnyActive = useEditingStore((s) => s.isAnyActive());
  const loadedRef = useRef(false);

  const searchKey = open && driveId
    ? `/api/tasks?context=drive&driveId=${driveId}&statusGroup=all&limit=20${
        debouncedQuery ? `&search=${encodeURIComponent(debouncedQuery)}` : ''
      }`
    : null;
  const { data: results = [], isLoading } = useSWR(searchKey, tasksFetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
    isPaused: () => loadedRef.current && isAnyActive,
    onSuccess: () => { loadedRef.current = true; },
  });
  const searching = isLoading || query !== debouncedQuery;

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const excluded = new Set(excludeIds);
  const visible = results.filter((t) => !excluded.has(t.id));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className={cn('h-7 justify-between font-normal', disabled && 'pointer-events-none opacity-60')}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <CheckSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">{placeholder}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={label} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{searching ? 'Searching…' : 'No tasks found.'}</CommandEmpty>
            {visible.map((task) => (
              <CommandItem
                key={task.id}
                value={task.id}
                onSelect={() => {
                  onSelect(task.id, task.title);
                  setOpen(false);
                }}
              >
                <CheckSquare className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{task.title}</span>
                  {task.taskListPageTitle && (
                    <span className="truncate text-xs text-muted-foreground">
                      {task.taskListPageTitle}
                    </span>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
