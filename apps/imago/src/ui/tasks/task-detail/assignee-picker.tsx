'use client';

import { useState, type ReactNode } from 'react';
import { Avatar } from '../../components/avatar/avatar';
import { AvatarGroup } from '../../components/avatar-group/avatar-group';
import { Icon } from '../../components/icon/icon';
import { Popover } from '../../components/popover/popover';
import { menuCheckClass, menuItemClass, menuLabelClass } from '../../components/popover/popover-class';
import type { Assignee } from '../task-model/task';
import {
  taskAssigneeEmptyClass,
  taskAssigneeFilterClass,
  taskAssigneeListClass,
  taskChipClass,
  taskUnassignedClass,
} from './task-detail-class';

export const sameAssignee = (a: Assignee, b: Assignee): boolean => a.type === b.type && a.id === b.id;

/** Who matches a filter: everyone for a blank one, else by name, ignoring case. */
export const matching = (people: readonly Assignee[], filter: string): readonly Assignee[] => {
  const needle = filter.trim().toLowerCase();
  return needle === '' ? people : people.filter((entry) => entry.name.toLowerCase().includes(needle));
};

export type AssigneePickerProps = {
  /** Who is on the task now. */
  readonly assigned: readonly Assignee[];
  /** Everyone who may be: the assignable, plus anyone on the task who no longer is. */
  readonly offered: readonly Assignee[];
  /** Void action: puts someone on the task, or takes them off. */
  readonly toggle: (assignee: Assignee) => void;
};

function AssigneeOptions({ assigned, offered, toggle }: AssigneePickerProps): ReactNode {
  const [filter, setFilter] = useState('');
  const shown = matching(offered, filter);
  return (
    <>
      <input
        type="search"
        aria-label="Filter people and agents"
        placeholder="Filter…"
        value={filter}
        className={taskAssigneeFilterClass}
        onChange={(event) => setFilter(event.currentTarget.value)}
      />
      <div className={taskAssigneeListClass}>
        {shown.length === 0 ? <p className={taskAssigneeEmptyClass}>No one matches</p> : null}
        {(['user', 'agent'] as const).map((type) => {
          const group = shown.filter((entry) => entry.type === type);
          const name = type === 'user' ? 'Members' : 'Agents';
          return group.length === 0 ? null : (
            <div key={type} role="group" aria-label={name} className="flex flex-col">
              <p className={menuLabelClass}>{name}</p>
              {group.map((entry) => {
                const on = assigned.some((other) => sameAssignee(entry, other));
                return (
                  <button
                    key={`${entry.type}:${entry.id}`}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={`Assign ${entry.name}`}
                    className={menuItemClass}
                    onClick={() => toggle(entry)}
                  >
                    <span aria-hidden="true" className="flex">
                      <Avatar name={entry.name} size="xs" agent={entry.type === 'agent'} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {on ? <Icon name="check" size={14} className={menuCheckClass} /> : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** The faces on the task as a chip; it opens the people and agents to tick, filtered as typed. */
export function AssigneePicker(props: AssigneePickerProps): ReactNode {
  const { assigned } = props;
  const agents = assigned.filter((entry) => entry.type === 'agent').map((entry) => entry.name);
  return (
    <Popover
      label="Assignees"
      trigger={
        <button type="button" className={taskChipClass}>
          {assigned.length === 0 ? (
            <span className={taskUnassignedClass}>Unassigned</span>
          ) : (
            <AvatarGroup names={assigned.map((entry) => entry.name)} agents={agents} label="Assigned to" />
          )}
          <Icon name="chevronDown" size={12} />
        </button>
      }
    >
      {() => <AssigneeOptions {...props} />}
    </Popover>
  );
}
