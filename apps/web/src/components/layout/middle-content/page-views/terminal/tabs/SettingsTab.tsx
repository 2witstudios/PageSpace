"use client";

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { del as apiDelete } from '@/lib/auth/auth-fetch';
import { useMachineSettings } from '@/hooks/useMachineSettings';

/**
 * The Machine page's Settings tab: a full-width form over the machine-settings
 * route. `machineId` IS the backing Machine page's id.
 *
 * All the load/save/resync state lives in {@link useMachineSettings} — the
 * failure path under concurrent saves is genuinely subtle and none of it is about
 * rendering. This component is the form and the delete action.
 *
 * The two access toggles (`visibleToGlobalAssistant` / `allowPageAgents`) are
 * persisted here but not yet enforced anywhere — the whole surface sits behind
 * `CODE_EXECUTION_ENABLED`.
 */
export default function SettingsTab({ machineId }: { machineId: string }) {
  const router = useRouter();
  const params = useParams();
  const driveId = typeof params?.driveId === 'string' ? params.driveId : undefined;

  const {
    settings,
    loading,
    pendingSaves,
    nameDraft,
    setNameDraft,
    descriptionDraft,
    setDescriptionDraft,
    commitName,
    commitDescription,
    setAccess,
    reload,
  } = useMachineSettings(machineId);

  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiDelete(`/api/machines/settings?machineId=${encodeURIComponent(machineId)}`);
      toast.success('Machine deleted');
      setConfirmOpen(false);
      router.push(driveId ? `/dashboard/${driveId}` : '/dashboard');
    } catch (error) {
      // Leave the dialog OPEN on failure so the user can simply retry.
      toast.error(error instanceof Error ? error.message : 'Failed to delete machine');
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Closing the confirm dialog always clears the in-progress state. The DELETE is
   * held open behind `preventDefault` (see below), so without this an Escape
   * during a hung request would strand `deleting: true` — reopening would then
   * show a permanently disabled "Deleting…" button with no way back.
   */
  function onConfirmOpenChange(open: boolean) {
    setConfirmOpen(open);
    if (!open) setDeleting(false);
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Could not load machine settings.</p>
        <Button type="button" variant="outline" size="sm" onClick={reload}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
        {/* Form-level, not per-card: any field or toggle below can be the one
            saving. An in-flight save is SURFACED, never ENFORCED — disabling the
            controls would swallow the very click that triggered the save (a
            field's blur-commit fires before the mouseup lands on a switch, so the
            switch would already be disabled by the time the click resolved). */}
        <div className="flex h-4 items-center justify-end">
          {pendingSaves > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </span>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">General</CardTitle>
            <CardDescription>The Machine&apos;s name and description.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="machine-name">Name</Label>
              <Input
                id="machine-name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="machine-description">Description</Label>
              <Textarea
                id="machine-description"
                value={descriptionDraft}
                placeholder="What is this Machine for?"
                onChange={(e) => setDescriptionDraft(e.target.value)}
                onBlur={commitDescription}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Assistant access</CardTitle>
            <CardDescription>Control which agents can see and use this Machine.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="machine-visible-global">Visible to global assistant</Label>
                <p className="text-xs text-muted-foreground">
                  Let the global assistant discover and switch to this Machine.
                </p>
              </div>
              <Switch
                id="machine-visible-global"
                checked={settings.visibleToGlobalAssistant}
                onCheckedChange={(checked) => setAccess({ visibleToGlobalAssistant: checked })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="machine-allow-page-agents">Allow page agents</Label>
                <p className="text-xs text-muted-foreground">
                  Let page-scoped agents run commands on this Machine.
                </p>
              </div>
              <Switch
                id="machine-allow-page-agents"
                checked={settings.allowPageAgents}
                onCheckedChange={(checked) => setAccess({ allowPageAgents: checked })}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="border-destructive/50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <TriangleAlert className="h-5 w-5 text-destructive" />
              <div>
                <CardTitle className="text-lg">Delete Machine</CardTitle>
                <CardDescription>
                  Trashes this Machine page and tears down its running compute.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <AlertDialog open={confirmOpen} onOpenChange={onConfirmOpenChange}>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="destructive">
                  <Trash2 className="h-4 w-4" />
                  Delete Machine
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this Machine?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This trashes the Machine page and tears down its Sprite and any branch compute.
                    You can restore the page from Trash, but its running sessions will be gone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                  {/* `AlertDialogAction` composes `DialogClose`, so without
                      preventDefault the dialog unmounts on the very click that
                      starts the request — the in-progress state could never
                      render, and a FAILED delete would toast against a dialog the
                      user then had to reopen. Hold it open until we know. */}
                  <AlertDialogAction
                    onClick={(e) => {
                      e.preventDefault();
                      handleDelete();
                    }}
                    disabled={deleting}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
                    {deleting ? 'Deleting…' : 'Delete Machine'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
