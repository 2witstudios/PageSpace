'use client';

import { useState, useEffect } from 'react';
import { Check, ChevronsUpDown, User, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { Actor } from './types';
import { getInitials } from './utils';

interface ActorFilterProps {
  driveId?: string;
  context: 'user' | 'drive';
  value?: string;
  onChange: (actorId?: string) => void;
}

export function ActorFilter({ driveId, context, value, onChange }: ActorFilterProps) {
  const [open, setOpen] = useState(false);
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchActors = async () => {
      if (context === 'user') {
        // In user context, there's only the current user, so no need for a filter
        setActors([]);
        return;
      }

      if (!driveId) {
        setActors([]);
        return;
      }

      setLoading(true);
      try {
        const response = await fetchWithAuth(`/api/activities/actors?context=${context}&driveId=${driveId}`);
        if (response.ok) {
          const data = await response.json();
          setActors(data.actors || []);
        }
      } catch (error) {
        console.error('Failed to fetch actors:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchActors();
  }, [driveId, context]);

  const selectedActor = actors.find((actor) => actor.id === value);

  const handleClear = () => {
    onChange(undefined);
  };

  // Don't show filter in user context (always showing own activity)
  if (context === 'user') {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'w-[180px] justify-between',
            !value && 'text-muted-foreground'
          )}
          disabled={loading || actors.length === 0}
        >
          <div className="flex items-center gap-2 truncate">
            {selectedActor ? (
              <>
                <Avatar className="h-5 w-5">
                  <AvatarImage src={selectedActor.image || undefined} />
                  <AvatarFallback className="text-[10px]">
                    {getInitials(selectedActor.name, selectedActor.email)}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate">{selectedActor.name || selectedActor.email}</span>
              </>
            ) : (
              <>
                <User className="h-4 w-4" />
                <span>All users</span>
              </>
            )}
          </div>
          {value ? (
            <X
              className="ml-2 h-4 w-4 shrink-0 opacity-50 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                handleClear();
              }}
            />
          ) : (
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search users..." />
          <CommandList>
            <CommandEmpty>No users found.</CommandEmpty>
            <CommandGroup>
              {actors.map((actor) => (
                <CommandItem
                  key={actor.id}
                  value={`${actor.name || ''} ${actor.email}`}
                  onSelect={() => {
                    onChange(actor.id === value ? undefined : actor.id);
                    setOpen(false);
                  }}
                >
                  <Avatar className="h-6 w-6 mr-2">
                    <AvatarImage src={actor.image || undefined} />
                    <AvatarFallback className="text-[10px]">
                      {getInitials(actor.name, actor.email)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">{actor.name || actor.email}</span>
                  <Check
                    className={cn(
                      'ml-auto h-4 w-4',
                      value === actor.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
