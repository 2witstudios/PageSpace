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
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { User, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DriveMember {
  userId: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  profile?: {
    displayName?: string;
    avatarUrl?: string;
  } | null;
}

interface AssigneeSelectProps {
  driveId: string;
  currentAssignee?: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
  onSelect: (userId: string | null) => void;
  disabled?: boolean;
}

const membersFetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch members');
  return res.json();
};

export function AssigneeSelect({
  driveId,
  currentAssignee,
  onSelect,
  disabled = false,
}: AssigneeSelectProps) {
  const [open, setOpen] = useState(false);

  const { data } = useSWR<{ members: DriveMember[] }>(
    driveId ? `/api/drives/${driveId}/members` : null,
    membersFetcher,
    { revalidateOnFocus: false }
  );

  const members = data?.members || [];

  const handleSelect = (userId: string | null) => {
    onSelect(userId);
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
          {currentAssignee ? (
            <div className="flex items-center gap-2">
              <Avatar className="h-5 w-5">
                <AvatarImage src={currentAssignee.image || undefined} />
                <AvatarFallback className="text-[10px]">
                  {getInitials(currentAssignee.name)}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm truncate max-w-20">
                {currentAssignee.name || 'Unknown'}
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
          <CommandInput placeholder="Search members..." />
          <CommandList>
            <CommandEmpty>No members found.</CommandEmpty>
            <CommandGroup>
              {/* Unassign option */}
              <CommandItem value="unassign" onSelect={() => handleSelect(null)}>
                <User className="mr-2 h-4 w-4 text-muted-foreground" />
                <span>Unassigned</span>
                {!currentAssignee && <Check className="ml-auto h-4 w-4" />}
              </CommandItem>

              {/* Member options */}
              {members.map((member) => {
                const displayName =
                  member.profile?.displayName ||
                  member.user.name ||
                  member.user.email;
                const avatarUrl = member.profile?.avatarUrl;
                const isSelected = currentAssignee?.id === member.userId;

                return (
                  <CommandItem
                    key={member.userId}
                    value={displayName}
                    onSelect={() => handleSelect(member.userId)}
                  >
                    <Avatar className="mr-2 h-5 w-5">
                      <AvatarImage src={avatarUrl} />
                      <AvatarFallback className="text-[10px]">
                        {getInitials(member.user.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate">{displayName}</span>
                    {isSelected && <Check className="ml-auto h-4 w-4" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
