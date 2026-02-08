'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { User, Check, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskAssigneeData } from './task-list-types';

interface Assignee {
  id: string;
  type: 'user' | 'agent';
  name: string;
  image: string | null;
}

interface MultiAssigneeSelectProps {
  driveId: string;
  assignees: TaskAssigneeData[];
  onUpdate: (assigneeIds: { type: 'user' | 'agent'; id: string }[]) => void;
  disabled?: boolean;
}

const assigneesFetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch assignees');
  return res.json();
};

function getInitials(name: string | null) {
  if (!name) return 'U';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function MultiAssigneeSelect({
  driveId,
  assignees,
  onUpdate,
  disabled = false,
}: MultiAssigneeSelectProps) {
  const [open, setOpen] = useState(false);

  const { data } = useSWR<{ assignees: Assignee[] }>(
    driveId ? `/api/drives/${driveId}/assignees` : null,
    assigneesFetcher,
    { revalidateOnFocus: false }
  );

  const availableAssignees = data?.assignees || [];
  const members = availableAssignees.filter(a => a.type === 'user');
  const agents = availableAssignees.filter(a => a.type === 'agent');

  // Build set of currently selected IDs
  const selectedIds = new Set<string>();
  for (const a of assignees) {
    if (a.userId) selectedIds.add(`user-${a.userId}`);
    if (a.agentPageId) selectedIds.add(`agent-${a.agentPageId}`);
  }

  const handleToggle = (assignee: Assignee) => {
    const key = `${assignee.type}-${assignee.id}`;
    const current = assignees.map(a => {
      if (a.userId) return { type: 'user' as const, id: a.userId };
      if (a.agentPageId) return { type: 'agent' as const, id: a.agentPageId };
      return null;
    }).filter((a): a is { type: 'user' | 'agent'; id: string } => a !== null);

    if (selectedIds.has(key)) {
      // Remove
      onUpdate(current.filter(a => !(a.type === assignee.type && a.id === assignee.id)));
    } else {
      // Add
      onUpdate([...current, { type: assignee.type, id: assignee.id }]);
    }
  };

  const handleClearAll = () => {
    onUpdate([]);
    setOpen(false);
  };

  // Display
  const userAssignees = assignees.filter(a => a.user).map(a => a.user!);
  const agentAssignees = assignees.filter(a => a.agentPage).map(a => a.agentPage!);
  const totalCount = userAssignees.length + agentAssignees.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'h-8 justify-start px-2 font-normal',
            disabled && 'pointer-events-none'
          )}
        >
          {totalCount > 0 ? (
            <div className="flex items-center gap-1">
              {/* Show stacked avatars for up to 3 assignees */}
              <div className="flex -space-x-1.5">
                {userAssignees.slice(0, 3).map(user => (
                  <Avatar key={user.id} className="h-5 w-5 border-2 border-background">
                    <AvatarImage src={user.image || undefined} />
                    <AvatarFallback className="text-[8px]">
                      {getInitials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                ))}
                {agentAssignees.slice(0, 3 - userAssignees.length).map(agent => (
                  <div key={agent.id} className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center border-2 border-background">
                    <Bot className="h-3 w-3 text-primary" />
                  </div>
                ))}
              </div>
              {totalCount > 3 && (
                <span className="text-xs text-muted-foreground">+{totalCount - 3}</span>
              )}
              {totalCount <= 2 && (
                <span className="text-xs truncate max-w-16">
                  {userAssignees[0]?.name || agentAssignees[0]?.title}
                  {totalCount > 1 && ` +${totalCount - 1}`}
                </span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground text-sm flex items-center gap-1">
              <User className="h-4 w-4" />
              Assign
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search members or agents..." />
          <CommandList>
            <CommandEmpty>No assignees found.</CommandEmpty>

            {/* Clear all option */}
            {totalCount > 0 && (
              <CommandGroup>
                <CommandItem value="clear-all" onSelect={handleClearAll}>
                  <User className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span>Clear all assignees</span>
                </CommandItem>
              </CommandGroup>
            )}

            {/* Members section */}
            {members.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Members">
                  {members.map(member => {
                    const isSelected = selectedIds.has(`user-${member.id}`);
                    return (
                      <CommandItem
                        key={`user-${member.id}`}
                        value={`user-${member.name}`}
                        onSelect={() => handleToggle(member)}
                      >
                        <Avatar className="mr-2 h-5 w-5">
                          <AvatarImage src={member.image || undefined} />
                          <AvatarFallback className="text-[10px]">
                            {getInitials(member.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="truncate">{member.name}</span>
                        {isSelected && <Check className="ml-auto h-4 w-4" />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}

            {/* Agents section */}
            {agents.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="AI Agents">
                  {agents.map(agent => {
                    const isSelected = selectedIds.has(`agent-${agent.id}`);
                    return (
                      <CommandItem
                        key={`agent-${agent.id}`}
                        value={`agent-${agent.name}`}
                        onSelect={() => handleToggle(agent)}
                      >
                        <div className="mr-2 h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center">
                          <Bot className="h-3 w-3 text-primary" />
                        </div>
                        <span className="truncate">{agent.name}</span>
                        {isSelected && <Check className="ml-auto h-4 w-4" />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
