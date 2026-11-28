'use client';

import React, { useMemo, useState } from 'react';
import Link from '@/retained-adapters/link';
import { Button } from '@/retained/components/ui/button';
import { Switch } from '@/retained/components/ui/switch';
import { Badge } from '@/retained/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/retained/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/retained/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/retained/components/ui/alert-dialog';
import { Loader2, MoreHorizontal, Pencil, Trash2, Plus } from 'lucide-react';
import { cn } from '@/retained/lib/utils';
import { SettingsGroup, SettingsRow, SettingsSection } from '@/ui/settings/settings-screen/settings-screen';
import { toast } from 'sonner';
import { useCommands } from '@/retained/hooks/useCommands';
import { useDriveStore } from '@/retained/hooks/useDrive';
import {
  personalCommands,
  commandsForDrive,
  shadowedDriveNames,
  type CommandItem,
} from '@/retained/lib/commands/command-list-core';
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
  type CommandFormScope,
} from '@/retained/lib/commands/command-form-core';
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

  const newCommandButton = canManage ? (
    <Button onClick={openCreate}>
      <Plus className="mr-2 h-4 w-4" />
      New command
    </Button>
  ) : undefined;

  const formDialogs = (
    <>
      <CommandFormDialog
        inline
        scope={scope}
        driveId={driveId}
        command={null}
        open={formOpen && editing === null}
        onOpenChange={setFormOpen}
        existingTriggers={existingTriggers}
        allCommands={commands}
        driveNameById={driveNameById}
        onCreate={createCommand}
        onUpdate={updateCommand}
      />
      <CommandFormDialog
        scope={scope}
        driveId={driveId}
        command={editing}
        open={formOpen && editing !== null}
        onOpenChange={setFormOpen}
        existingTriggers={existingTriggers}
        allCommands={commands}
        driveNameById={driveNameById}
        onCreate={createCommand}
        onUpdate={updateCommand}
      />
    </>
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <>
        <SettingsSection
          title={EMPTY_STATE_TITLE}
          description={EMPTY_STATE_SUBTEXT[scope]}
          actions={newCommandButton}
        />
        {formDialogs}
      </>
    );
  }

  return (
    <>
      <SettingsSection
        title={scope === 'personal' ? 'Your commands' : 'Drive commands'}
        actions={newCommandButton}
      >
        <SettingsGroup label={scope === 'personal' ? 'Your commands' : 'Drive commands'}>
          {list.map((command) => {
            const shadowsDrives =
              scope === 'personal'
                ? shadowedDriveNames(command.trigger, commands, driveNameById)
                : [];
            return (
              <SettingsRow
                key={command.id}
                label={
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        'font-mono text-sm font-semibold',
                        !command.enabled && 'text-muted-foreground'
                      )}
                    >
                      /{command.trigger}
                    </span>
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
                      <Badge
                        variant="outline"
                        className="shrink-0"
                        title={`Overrides the drive command with the same trigger in ${shadowsDrives.join(', ')}`}
                      >
                        Shadows {shadowsDrives.join(', ')}
                      </Badge>
                    )}
                  </span>
                }
                hint={
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block truncate">{command.description}</span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">{command.description}</TooltipContent>
                    </Tooltip>
                    <span className="mt-0.5 flex items-center gap-2">
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
                    </span>
                  </>
                }
              >
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
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      </SettingsSection>

      {formDialogs}

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
