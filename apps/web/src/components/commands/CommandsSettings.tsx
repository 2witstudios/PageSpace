'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2, MoreHorizontal, Pencil, Trash2, Plus, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { useCommands } from '@/hooks/useCommands';
import { useDriveStore } from '@/hooks/useDrive';
import {
  personalCommands,
  commandsForDrive,
  shadowedDriveNames,
  type CommandItem,
} from '@/lib/commands/command-list-core';
import {
  toggleToast,
  TOGGLE_FAILED_TOAST,
  deleteToast,
  deleteDialogTitle,
  DELETE_DIALOG_BODY,
  EMPTY_STATE_TITLE,
  EMPTY_STATE_SUBTEXT,
  ENTRY_PAGE_UNAVAILABLE_BADGE,
  ENTRY_PAGE_UNAVAILABLE_TOOLTIP,
  PERSONAL_SHADOW_TOOLTIP,
  type CommandFormScope,
} from '@/lib/commands/command-form-core';
import { CommandFormDialog } from './CommandFormDialog';

interface CommandsSettingsProps {
  scope: CommandFormScope;
  /** Required when scope is 'drive'. */
  driveId?: string;
  /** Whether the viewer may create/edit/delete/toggle (spec §4.1). */
  canManage: boolean;
}

export function CommandsSettings({ scope, driveId, canManage }: CommandsSettingsProps) {
  const { commands, isLoading, toggleEnabled, createCommand, updateCommand, deleteCommand } =
    useCommands();
  const drives = useDriveStore((state) => state.drives);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CommandItem | null>(null);
  const [deleting, setDeleting] = useState<CommandItem | null>(null);

  const driveNameById = useMemo(
    () => new Map(drives.map((drive) => [drive.id, drive.name])),
    [drives]
  );

  const list = useMemo(
    () =>
      scope === 'personal'
        ? personalCommands(commands)
        : commandsForDrive(commands, driveId ?? ''),
    [commands, scope, driveId]
  );

  const existingTriggers = useMemo(
    () => list.filter((command) => command.id !== editing?.id).map((command) => command.trigger),
    [list, editing]
  );

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (command: CommandItem) => {
    setEditing(command);
    setFormOpen(true);
  };

  const handleToggle = async (command: CommandItem, enabled: boolean) => {
    try {
      await toggleEnabled(command.id, enabled);
      toast.success(toggleToast(command.trigger, enabled));
    } catch {
      toast.error(TOGGLE_FAILED_TOAST);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const trigger = deleting.trigger;
    setDeleting(null);
    try {
      await deleteCommand(deleting.id);
      toast.success(deleteToast(trigger));
    } catch {
      toast.error('Failed to delete command');
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (list.length === 0) {
    return (
      <>
        <Card>
          <CardHeader className="items-center text-center">
            <CardTitle>{EMPTY_STATE_TITLE}</CardTitle>
            <CardDescription>{EMPTY_STATE_SUBTEXT[scope]}</CardDescription>
          </CardHeader>
          {canManage && (
            <CardContent className="flex justify-center pb-8">
              <Button onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" />
                New command
              </Button>
            </CardContent>
          )}
        </Card>
        <CommandFormDialog
          scope={scope}
          driveId={driveId}
          command={editing}
          open={formOpen}
          onOpenChange={setFormOpen}
          existingTriggers={existingTriggers}
          allCommands={commands}
          driveNameById={driveNameById}
          onCreate={createCommand}
          onUpdate={updateCommand}
        />
      </>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{scope === 'personal' ? 'Your commands' : 'Drive commands'}</CardTitle>
              <CardDescription>{EMPTY_STATE_SUBTEXT[scope]}</CardDescription>
            </div>
            {canManage && (
              <Button onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" />
                New command
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="divide-y divide-border p-0">
          {list.map((command) => {
            const shadowsDrives =
              scope === 'personal'
                ? shadowedDriveNames(command.trigger, commands, driveNameById)
                : [];
            return (
              <div key={command.id} className="flex items-center gap-3 px-6 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">/{command.trigger}</span>
                    {!command.entryPageAvailable && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="destructive" className="shrink-0">
                            {ENTRY_PAGE_UNAVAILABLE_BADGE}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          {ENTRY_PAGE_UNAVAILABLE_TOOLTIP}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {shadowsDrives.length > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Layers
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label="Shadows a drive command"
                          />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          {PERSONAL_SHADOW_TOOLTIP}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="truncate text-xs text-muted-foreground">
                        {command.description}
                      </p>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm">{command.description}</TooltipContent>
                  </Tooltip>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    {command.entryPageAvailable && command.entryPageTitle ? (
                      <Link
                        href={`/p/${command.entryPageId}`}
                        className="truncate underline-offset-2 hover:underline"
                      >
                        {command.entryPageTitle}
                      </Link>
                    ) : command.entryPageTitle ? (
                      <span className="truncate">{command.entryPageTitle}</span>
                    ) : null}
                    {scope === 'drive' && command.authorName && (
                      <span className="shrink-0">Added by {command.authorName}</span>
                    )}
                  </div>
                </div>
                <Switch
                  checked={command.enabled}
                  disabled={!canManage}
                  onCheckedChange={(enabled) => void handleToggle(command, enabled)}
                  aria-label={`${command.enabled ? 'Disable' : 'Enable'} /${command.trigger}`}
                />
                {canManage && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`Actions for /${command.trigger}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(command)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setDeleting(command)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <CommandFormDialog
        scope={scope}
        driveId={driveId}
        command={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
        existingTriggers={existingTriggers}
        allCommands={commands}
        driveNameById={driveNameById}
        onCreate={createCommand}
        onUpdate={updateCommand}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting ? deleteDialogTitle(deleting.trigger) : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>{DELETE_DIALOG_BODY[scope]}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleDelete()}
            >
              Delete command
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
