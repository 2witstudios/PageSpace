'use client';

import { Bot } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/retained/components/ui/avatar';
import { cn } from '@/retained/lib/utils';
import type { TaskItem } from './task-list-types';

export interface AssigneeAvatar {
  readonly id: string;
  readonly kind: 'user' | 'agent';
  readonly name: string;
  readonly image: string | null;
}

type AssigneeSource = Pick<TaskItem, 'assignees' | 'assignee' | 'assigneeAgent'>;

/**
 * Who a task is with, one entry per assignee. Multiple assignees come from the
 * assignee rows; the legacy single-assignee relations fill in only when no row
 * resolves to a person or an agent.
 */
export function assigneeAvatars(task: AssigneeSource): readonly AssigneeAvatar[] {
  const fromRows = (task.assignees ?? []).flatMap((row): AssigneeAvatar[] => {
    if (row.user) return [{ id: row.id, kind: 'user', name: row.user.name ?? 'Unnamed', image: row.user.image }];
    if (row.agentPage) return [{ id: row.id, kind: 'agent', name: row.agentPage.title ?? 'Agent', image: null }];
    return [];
  });
  if (fromRows.length > 0) return fromRows;

  const legacy: AssigneeAvatar[] = [];
  if (task.assignee) {
    legacy.push({ id: `user-${task.assignee.id}`, kind: 'user', name: task.assignee.name ?? 'Unnamed', image: task.assignee.image });
  }
  if (task.assigneeAgent) {
    legacy.push({ id: `agent-${task.assigneeAgent.id}`, kind: 'agent', name: task.assigneeAgent.title ?? 'Agent', image: null });
  }
  return legacy;
}

/** Up to two initials from a display name; "?" when there is nothing to show. */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';

/**
 * The assignee avatars on a card or row: people round with initials, agents
 * square with a bot mark, the board's own distinction between the two.
 */
export function AssigneeAvatars({ task, max = 3 }: { readonly task: AssigneeSource; readonly max?: number }) {
  const people = assigneeAvatars(task).slice(0, max);
  if (people.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center">
      {people.map((person, index) =>
        person.kind === 'user' ? (
          <Avatar
            key={person.id}
            title={person.name}
            className={cn('h-5 w-5 border-2 border-background', index > 0 && '-ml-1.5')}
          >
            <AvatarImage src={person.image ?? undefined} alt="" />
            <AvatarFallback className="text-[8px]">{initialsOf(person.name)}</AvatarFallback>
            <span className="sr-only">{person.name}</span>
          </Avatar>
        ) : (
          <span
            key={person.id}
            title={person.name}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-md border-2 border-background bg-primary/10',
              index > 0 && '-ml-1.5',
            )}
          >
            <Bot className="h-3 w-3 text-primary" aria-hidden="true" />
            <span className="sr-only">{person.name}</span>
          </span>
        ),
      )}
    </span>
  );
}
