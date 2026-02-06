'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { post, put, del } from '@/lib/auth/auth-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Plus, Settings2, GripVertical, MoreHorizontal, Trash2, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskStatusConfig, TaskStatusGroup } from './task-list-types';

const GROUP_LABELS: Record<TaskStatusGroup, string> = {
  todo: 'Not Started',
  in_progress: 'In Progress',
  done: 'Done',
};

const GROUP_COLORS: Record<TaskStatusGroup, string> = {
  todo: 'text-slate-600',
  in_progress: 'text-amber-600',
  done: 'text-green-600',
};

const PRESET_COLORS = [
  'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
];

interface StatusConfigManagerProps {
  pageId: string;
  statusConfigs: TaskStatusConfig[];
  onConfigsChanged: () => void;
  disabled?: boolean;
}

export function StatusConfigManager({
  pageId,
  statusConfigs,
  onConfigsChanged,
  disabled = false,
}: StatusConfigManagerProps) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [newGroup, setNewGroup] = useState<TaskStatusGroup>('todo');
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editGroup, setEditGroup] = useState<TaskStatusGroup>('todo');

  const handleAddStatus = async () => {
    if (!newName.trim()) return;

    try {
      await post(`/api/pages/${pageId}/tasks/statuses`, {
        name: newName.trim(),
        color: newColor,
        group: newGroup,
      });
      setNewName('');
      setAdding(false);
      onConfigsChanged();
    } catch {
      toast.error('Failed to add status');
    }
  };

  const handleUpdateStatus = async (config: TaskStatusConfig) => {
    try {
      await put(`/api/pages/${pageId}/tasks/statuses`, {
        statuses: statusConfigs.map(c =>
          c.id === config.id
            ? { ...c, name: editName.trim(), color: editColor, group: editGroup }
            : c
        ),
      });
      setEditingId(null);
      onConfigsChanged();
    } catch {
      toast.error('Failed to update status');
    }
  };

  const handleDeleteStatus = async (config: TaskStatusConfig) => {
    // Find a status to migrate tasks to (first status in same group, or first overall)
    const sameGroupStatuses = statusConfigs.filter(
      c => c.group === config.group && c.id !== config.id
    );
    const migrateTarget = sameGroupStatuses[0] || statusConfigs.find(c => c.id !== config.id);

    if (!migrateTarget) {
      toast.error('Cannot delete the last status');
      return;
    }

    try {
      await del(`/api/pages/${pageId}/tasks/statuses?statusId=${config.id}&migrateToSlug=${migrateTarget.slug}`);
      onConfigsChanged();
    } catch {
      toast.error('Failed to delete status');
    }
  };

  const handleReorder = async (configs: TaskStatusConfig[]) => {
    try {
      await put(`/api/pages/${pageId}/tasks/statuses`, {
        statuses: configs.map((c, i) => ({ ...c, position: i })),
      });
      onConfigsChanged();
    } catch {
      toast.error('Failed to reorder statuses');
    }
  };

  const startEditing = (config: TaskStatusConfig) => {
    setEditingId(config.id);
    setEditName(config.name);
    setEditColor(config.color);
    setEditGroup(config.group);
  };

  // Group configs by group for display
  const groupedConfigs: Record<TaskStatusGroup, TaskStatusConfig[]> = {
    todo: [],
    in_progress: [],
    done: [],
  };
  for (const config of statusConfigs) {
    groupedConfigs[config.group]?.push(config);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild disabled={disabled}>
        <Button variant="ghost" size="sm" className="h-8 gap-1">
          <Settings2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Statuses</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Manage Status Categories</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {(['todo', 'in_progress', 'done'] as const).map(group => (
            <div key={group}>
              <h4 className={cn('text-xs font-semibold uppercase tracking-wide mb-2', GROUP_COLORS[group])}>
                {GROUP_LABELS[group]}
              </h4>
              <div className="space-y-1">
                {groupedConfigs[group].map(config => (
                  <div key={config.id} className="flex items-center gap-2 p-1.5 rounded hover:bg-muted/50 group">
                    <GripVertical className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />

                    {editingId === config.id ? (
                      <div className="flex-1 flex items-center gap-2">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-7 text-sm"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleUpdateStatus(config);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <Select value={editGroup} onValueChange={(v) => setEditGroup(v as TaskStatusGroup)}>
                          <SelectTrigger className="h-7 w-28 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="todo">Not Started</SelectItem>
                            <SelectItem value="in_progress">In Progress</SelectItem>
                            <SelectItem value="done">Done</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditingId(null)}>
                            Cancel
                          </Button>
                          <Button size="sm" className="h-7 px-2 text-xs" onClick={() => handleUpdateStatus(config)}>
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <Badge className={cn('text-xs', config.color)}>{config.name}</Badge>
                        <span className="text-xs text-muted-foreground ml-auto opacity-0 group-hover:opacity-100">
                          {config.slug}
                        </span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100">
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => startEditing(config)}>
                              <Pencil className="h-3.5 w-3.5 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDeleteStatus(config)}
                              className="text-destructive"
                              disabled={statusConfigs.length <= 1}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Add new status */}
          {adding ? (
            <div className="border rounded-lg p-3 space-y-3">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Status name..."
                autoFocus
                className="h-8"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddStatus();
                  if (e.key === 'Escape') setAdding(false);
                }}
              />
              <div className="flex items-center gap-2">
                <Select value={newGroup} onValueChange={(v) => setNewGroup(v as TaskStatusGroup)}>
                  <SelectTrigger className="h-8 w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todo">Not Started</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="done">Done</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_COLORS.map(color => (
                  <button
                    key={color}
                    className={cn(
                      'w-6 h-6 rounded border-2 transition-colors',
                      color.split(' ').find(c => c.startsWith('bg-')),
                      newColor === color ? 'border-primary' : 'border-transparent'
                    )}
                    onClick={() => setNewColor(color)}
                  />
                ))}
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
                <Button size="sm" onClick={handleAddStatus} disabled={!newName.trim()}>Add Status</Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add Status
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
