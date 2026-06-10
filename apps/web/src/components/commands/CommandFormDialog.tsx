'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { EntryPagePicker, type EntryPageSelection } from './EntryPagePicker';
import type { CommandItem } from '@/lib/commands/command-list-core';
import { shadowedDriveNames } from '@/lib/commands/command-list-core';
import {
  normalizeTriggerInput,
  computeFormErrors,
  isSaveBlocked,
  sizeAdvisory,
  shadowNotice,
  buildCreatePayload,
  buildUpdatePayload,
  saveToast,
  SAVE_FAILED_TOAST,
  type CommandFormScope,
  type CommandPayloadValues,
  type CreateCommandPayload,
} from '@/lib/commands/command-form-core';
import { COMMAND_DESCRIPTION_MAX_LENGTH } from '@pagespace/lib/commands/command-core';

interface CommandFormDialogProps {
  scope: CommandFormScope;
  /** Required for drive scope: the drive the command (and its entry page) belongs to. */
  driveId?: string;
  /** The command being edited, or null to create. */
  command: CommandItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Triggers already taken in the same scope, excluding the edited command. */
  existingTriggers: string[];
  /** All visible commands — used for the W2 cross-scope shadow notice (personal only). */
  allCommands: CommandItem[];
  driveNameById: ReadonlyMap<string, string>;
  onCreate: (payload: CreateCommandPayload) => Promise<void>;
  onUpdate: (commandId: string, payload: Partial<CommandPayloadValues>) => Promise<void>;
}

interface FormValues {
  trigger: string;
  description: string;
  entryPage: EntryPageSelection | null;
  enabled: boolean;
}

const emptyValues: FormValues = {
  trigger: '',
  description: '',
  entryPage: null,
  enabled: true,
};

function initialValues(command: CommandItem | null): FormValues {
  if (!command) return emptyValues;
  return {
    trigger: command.trigger,
    description: command.description,
    entryPage: {
      id: command.entryPageId,
      title: command.entryPageTitle ?? 'Untitled',
      driveId: command.entryPageDriveId,
    },
    enabled: command.enabled,
  };
}

export function CommandFormDialog({
  scope,
  driveId,
  command,
  open,
  onOpenChange,
  existingTriggers,
  allCommands,
  driveNameById,
  onCreate,
  onUpdate,
}: CommandFormDialogProps) {
  const isMobile = useBreakpoint('(max-width: 639px)');
  const isEdit = command !== null;

  const [values, setValues] = useState<FormValues>(emptyValues);
  const [touched, setTouched] = useState<{ trigger: boolean; description: boolean; entryPage: boolean }>({
    trigger: false,
    description: false,
    entryPage: false,
  });
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sizeWarning, setSizeWarning] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const triggerRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const entryPageRef = useRef<HTMLDivElement>(null);

  // Reset whenever the dialog opens (for a different command or a new one)
  useEffect(() => {
    if (open) {
      const initial = initialValues(command);
      setValues(initial);
      setTouched({ trigger: false, description: false, entryPage: false });
      setSubmitAttempted(false);
      setSizeWarning(null);
      // W1 persists until the condition clears — re-check the prefilled page on edit
      if (initial.entryPage) void checkEntryPageSize(initial.entryPage.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, command?.id]);

  const errors = computeFormErrors(
    {
      trigger: values.trigger,
      description: values.description,
      entryPageId: values.entryPage?.id ?? null,
    },
    { scope, existingTriggers }
  );
  const blocked = isSaveBlocked(errors);

  const showError = (field: 'trigger' | 'description' | 'entryPage') =>
    touched[field] || submitAttempted;

  // W2 — personal trigger colliding with drive commands (advisory, never blocks)
  const shadowWarning =
    scope === 'personal' && !errors.trigger && values.trigger
      ? shadowNotice(
          values.trigger,
          shadowedDriveNames(values.trigger, allCommands, driveNameById)
        )
      : null;

  // W1 — advisory size check, fetched when an entry page is selected
  const checkEntryPageSize = useCallback(async (pageId: string) => {
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}`);
      if (!response.ok) {
        setSizeWarning(null);
        return;
      }
      const page: { content?: string | null } = await response.json();
      setSizeWarning(sizeAdvisory(page.content ?? ''));
    } catch {
      setSizeWarning(null);
    }
  }, []);

  const handleEntryPageChange = (page: EntryPageSelection | null) => {
    setValues((prev) => ({ ...prev, entryPage: page }));
    setTouched((prev) => ({ ...prev, entryPage: true }));
    setSizeWarning(null);
    if (page) void checkEntryPageSize(page.id);
  };

  const initial = initialValues(command);
  const isDirty =
    values.trigger !== initial.trigger ||
    values.description !== initial.description ||
    (values.entryPage?.id ?? null) !== (initial.entryPage?.id ?? null) ||
    values.enabled !== initial.enabled;

  const requestClose = (nextOpen: boolean) => {
    if (!nextOpen && isDirty && !isSaving) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(nextOpen);
  };

  const focusFirstError = () => {
    if (errors.trigger) triggerRef.current?.focus();
    else if (errors.description) descriptionRef.current?.focus();
    else if (errors.entryPage) entryPageRef.current?.focus();
  };

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setSubmitAttempted(true);
    if (blocked) {
      focusFirstError();
      return;
    }
    const payloadValues: CommandPayloadValues = {
      trigger: values.trigger,
      description: values.description,
      entryPageId: values.entryPage?.id as string,
      enabled: values.enabled,
    };
    setIsSaving(true);
    try {
      if (isEdit && command) {
        const payload = buildUpdatePayload(
          {
            trigger: command.trigger,
            description: command.description,
            entryPageId: command.entryPageId,
            enabled: command.enabled,
          },
          payloadValues
        );
        if (Object.keys(payload).length > 0) {
          await onUpdate(command.id, payload);
        }
      } else {
        await onCreate(buildCreatePayload(payloadValues, driveId ?? null));
      }
      toast.success(saveToast(values.trigger, isEdit));
      onOpenChange(false);
    } catch {
      // Keep the form open so nothing the user typed is lost
      toast.error(SAVE_FAILED_TOAST);
    } finally {
      setIsSaving(false);
    }
  };

  const descriptionLength = values.description.length;

  const form = (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="command-trigger">Trigger</Label>
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
          >
            /
          </span>
          <Input
            id="command-trigger"
            ref={triggerRef}
            value={values.trigger}
            autoComplete="off"
            spellCheck={false}
            className="pl-6 font-mono"
            aria-invalid={showError('trigger') && !!errors.trigger}
            aria-describedby="command-trigger-error command-trigger-shadow"
            onChange={(event) =>
              setValues((prev) => ({
                ...prev,
                trigger: normalizeTriggerInput(event.target.value),
              }))
            }
            onBlur={() => setTouched((prev) => ({ ...prev, trigger: true }))}
          />
        </div>
        {showError('trigger') && errors.trigger && (
          <p id="command-trigger-error" role="alert" className="text-sm text-destructive">
            {errors.trigger.message}
          </p>
        )}
        {shadowWarning && (
          <p
            id="command-trigger-shadow"
            role="status"
            className="text-sm text-amber-600 dark:text-amber-500"
          >
            {shadowWarning}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="command-description">Description</Label>
        <Textarea
          id="command-description"
          ref={descriptionRef}
          value={values.description}
          className="min-h-[88px] resize-y"
          aria-invalid={showError('description') && !!errors.description}
          aria-describedby="command-description-help command-description-error"
          onChange={(event) =>
            setValues((prev) => ({ ...prev, description: event.target.value }))
          }
          onBlur={() => setTouched((prev) => ({ ...prev, description: true }))}
        />
        <div className="flex items-start justify-between gap-4">
          <p id="command-description-help" className="text-xs text-muted-foreground">
            Describe what this command does <em>and when the AI should use it.</em> This is
            shown in the picker and given to the AI.
          </p>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {descriptionLength.toLocaleString('en-US')} /{' '}
            {COMMAND_DESCRIPTION_MAX_LENGTH.toLocaleString('en-US')}
          </span>
        </div>
        {showError('description') && errors.description && (
          <p id="command-description-error" role="alert" className="text-sm text-destructive">
            {errors.description.message}
          </p>
        )}
      </div>

      <div className="space-y-1.5" ref={entryPageRef} tabIndex={-1}>
        <Label>Entry page</Label>
        <EntryPagePicker
          driveId={scope === 'drive' ? driveId : undefined}
          value={values.entryPage}
          onChange={handleEntryPageChange}
          invalid={showError('entryPage') && !!errors.entryPage}
          describedBy="command-entry-page-error command-entry-page-size"
        />
        {showError('entryPage') && errors.entryPage && (
          <p id="command-entry-page-error" role="alert" className="text-sm text-destructive">
            {errors.entryPage.message}
          </p>
        )}
        {sizeWarning && (
          <p
            id="command-entry-page-size"
            role="status"
            className="text-sm text-amber-600 dark:text-amber-500"
          >
            {sizeWarning}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="command-enabled">Enabled</Label>
        <Switch
          id="command-enabled"
          checked={values.enabled}
          onCheckedChange={(enabled) => setValues((prev) => ({ ...prev, enabled }))}
        />
      </div>
    </form>
  );

  const footer = (
    <>
      <Button type="button" variant="outline" onClick={() => requestClose(false)}>
        Cancel
      </Button>
      <Button type="button" onClick={() => void handleSubmit()} disabled={blocked || isSaving}>
        {isSaving ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Saving…
          </>
        ) : isEdit ? (
          'Save changes'
        ) : (
          'Create command'
        )}
      </Button>
    </>
  );

  const title = isEdit ? `Edit /${command.trigger}` : 'New command';
  const subtitle =
    scope === 'drive'
      ? 'Drive commands are available to everyone in this drive.'
      : 'Personal commands follow you into every drive.';

  return (
    <>
      {isMobile ? (
        <Sheet open={open} onOpenChange={requestClose}>
          <SheetContent side="bottom" className="h-full overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{subtitle}</SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-4">{form}</div>
            <SheetFooter className="flex-row justify-end gap-2">{footer}</SheetFooter>
          </SheetContent>
        </Sheet>
      ) : (
        <Dialog open={open} onOpenChange={requestClose}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{subtitle}</DialogDescription>
            </DialogHeader>
            {form}
            <DialogFooter>{footer}</DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. If you close now, they will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDiscard(false);
                onOpenChange(false);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
