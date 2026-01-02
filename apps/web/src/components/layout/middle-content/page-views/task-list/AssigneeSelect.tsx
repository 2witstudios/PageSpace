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

interface Assignee {
  id: string;
  type: 'user' | 'agent';
  name: string;
  image: string | null;
  agentTitle?: string;
}

interface AssigneeSelectProps {
  driveId: string;
  currentAssignee?: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
  currentAssigneeAgent?: {
    id: string;
    title: string | null;
    type: string;
  } | null;
  onSelect: (
    userId: string | null,
    agentId: string | null,
    data?: { id: string; name: string | null; image: string | null; type: 'user' | 'agent' } | null
  ) => void;
  disabled?: boolean;
}

const assigneesFetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch assignees');
  return res.json();
};

export function AssigneeSelect({
  driveId,
  currentAssignee,
  currentAssigneeAgent,
  onSelect,
  disabled = false,
}: AssigneeSelectProps) {
  const [open, setOpen] = useState(false);

  const { data } = useSWR<{ assignees: Assignee[] }>(
    driveId ? `/api/drives/${driveId}/assignees` : null,
    assigneesFetcher,
    { revalidateOnFocus: false }
  );

  const assignees = data?.assignees || [];
  const members = assignees.filter(a => a.type === 'user');
  const agents = assignees.filter(a => a.type === 'agent');

  // Determine current selection
  const hasUserAssignee = !!currentAssignee;
  const hasAgentAssignee = !!currentAssigneeAgent;
  const currentId = currentAssignee?.id || currentAssigneeAgent?.id;
  const currentType = hasAgentAssignee ? 'agent' : (hasUserAssignee ? 'user' : null);

  const handleSelect = (assignee: Assignee | null) => {
    if (!assignee) {
      // Unassign
      onSelect(null, null, null);
    } else if (assignee.type === 'user') {
      onSelect(assignee.id, null, {
        id: assignee.id,
        name: assignee.name,
        image: assignee.image,
        type: 'user',
      });
    } else {
      // Agent
      onSelect(null, assignee.id, {
        id: assignee.id,
        name: assignee.name,
        image: null,
        type: 'agent',
      });
    }
    setOpen(false);
  };

  const getInitials = (name: string | null) => {
    if (!name) return 'U';
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const displayName = currentAssigneeAgent?.title || currentAssignee?.name || null;
  const displayImage = currentAssignee?.image || null;
  const isAgent = !!currentAssigneeAgent;

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
          {displayName ? (
            <div className="flex items-center gap-2">
              {isAgent ? (
                <div className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center">
                  <Bot className="h-3 w-3 text-primary" />
                </div>
              ) : (
                <Avatar className="h-5 w-5">
                  <AvatarImage src={displayImage || undefined} />
                  <AvatarFallback className="text-[10px]">
                    {getInitials(displayName)}
                  </AvatarFallback>
                </Avatar>
              )}
              <span className="text-sm truncate max-w-20">
                {displayName}
              </span>
            </div>
          ) : (
            <span className="text-muted-foreground text-sm flex items-center gap-1">
              <User className="h-4 w-4" />
              Unassigned
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search members or agents..." />
          <CommandList>
            <CommandEmpty>No assignees found.</CommandEmpty>

            {/* Unassign option */}
            <CommandGroup>
              <CommandItem value="unassign" onSelect={() => handleSelect(null)}>
                <User className="mr-2 h-4 w-4 text-muted-foreground" />
                <span>Unassigned</span>
                {!currentId && <Check className="ml-auto h-4 w-4" />}
              </CommandItem>
            </CommandGroup>

            {/* Members section */}
            {members.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Members">
                  {members.map((member) => {
                    const isSelected = currentType === 'user' && currentId === member.id;

                    return (
                      <CommandItem
                        key={`user-${member.id}`}
                        value={`user-${member.name}`}
                        onSelect={() => handleSelect(member)}
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
                  {agents.map((agent) => {
                    const isSelected = currentType === 'agent' && currentId === agent.id;

                    return (
                      <CommandItem
                        key={`agent-${agent.id}`}
                        value={`agent-${agent.name}`}
                        onSelect={() => handleSelect(agent)}
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
