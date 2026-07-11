"use client";

import { useEffect, useRef, useState } from 'react';
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
import { fetchWithAuth, patch as apiPatch, del as apiDelete } from '@/lib/auth/auth-fetch';
import type {
  MachineSettings,
  MachineSettingsPatch,
} from '@pagespace/lib/services/machines/machine-settings';

/**
 * The Machine page's Settings tab: a full-width form over the machine-settings
 * route (`/api/machines/settings`). It mirrors `TerminalAccessCard`'s shape —
 * a plain `useState`/`useEffect` fetch plus an optimistic `persist()` helper
 * (local update → PATCH → rollback + toast on error). No React Hook Form, no SWR.
 *
 * `machineId` IS the backing Machine page's id. The two access toggles
 * (`visibleToGlobalAssistant` / `allowPageAgents`) are persisted here but not yet
 * enforced anywhere — the whole surface sits behind `CODE_EXECUTION_ENABLED`.
 *
 * Delete is gated behind an `AlertDialog` because it is irreversible from the
 * user's point of view (the route soft-trashes the page and tears down the
 * Sprite); on success we navigate back to the drive, off the now-trashed page.
 */
export default function SettingsTab({ machineId }: { machineId: string }) {
  const router = useRouter();
  const params = useParams();
  const driveId = typeof params?.driveId === 'string' ? params.driveId : undefined;

  const [settings, setSettings] = useState<MachineSettings | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // In-flight save COUNT, not a flag: a text field's blur-commit and a switch
  // click can be airborne at once, and a boolean would report "done" as soon as
  // the first of them settled.
  const [pendingSaves, setPendingSaves] = useState(0);

  // Local drafts for the text fields — inputs stay editable per-keystroke and
  // only persist on blur (the toggles persist immediately). Seeded from the
  // server whenever settings (re)load.
  const [nameDraft, setNameDraft] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');

  // Which machine's settings we currently hold. A `reloadToken` refetch of the
  // SAME machine (retry after a load error, resync after a failed save)
  // revalidates in place, so a failed toggle doesn't flash the whole form away
  // and back — but a different `machineId` must block on the spinner rather than
  // render the previous machine's settings as if they were this one's.
  const loadedFor = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (loadedFor.current !== machineId) {
      // Drop the previous machine's settings before loading a different one —
      // otherwise a FAILED load would fall through to rendering the old machine's
      // name/toggles under the new machine's identity.
      setSettings(null);
      setLoading(true);
    }
    (async () => {
      try {
        const response = await fetchWithAuth(
          `/api/machines/settings?machineId=${encodeURIComponent(machineId)}`,
        );
        if (!response.ok) throw new Error('Failed to load machine settings');
        const json = (await response.json()) as { settings: MachineSettings };
        if (!cancelled) {
          loadedFor.current = machineId;
          setSettings(json.settings);
          setNameDraft(json.settings.name);
          setDescriptionDraft(json.settings.description ?? '');
        }
      } catch (error) {
        console.error('Failed to load machine settings:', error);
        // A failed RESYNC keeps the form (and its already-good settings) on screen
        // — only a failed FIRST load falls through to the error state below.
        if (!cancelled) toast.error('Failed to load machine settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId, reloadToken]);

  /**
   * Optimistically apply `patch`, PATCH it, and on failure revert + resync.
   *
   * We do NOT reconcile from the PATCH response body. The route echoes the whole
   * `MachineSettings`, so applying it would clobber a field the user is
   * concurrently editing with a value that was already stale when the request
   * left. Every field we send is normalized client-side exactly as the route
   * normalizes it (name trimmed; blank description → null), so on success the
   * optimistic value already equals the persisted one.
   *
   * On failure the local snapshot is only a GUESS at server truth — the request
   * may have committed and then timed out, and two saves in flight can land out
   * of order. So we revert optimistically (instant, no flicker) and then refetch,
   * which is authoritative and settles both cases. Without that refetch a
   * commit-then-timeout would strand the tab showing the old value forever, with
   * nothing to revalidate it (no SWR, no socket subscription here).
   */
  async function persist(patch: MachineSettingsPatch) {
    if (!settings) return;
    const previous = settings;
    setSettings((current) => (current ? { ...current, ...patch } : current));
    setPendingSaves((n) => n + 1);
    try {
      await apiPatch('/api/machines/settings', { machineId, ...patch });
    } catch (error) {
      setSettings(previous);
      setNameDraft(previous.name);
      setDescriptionDraft(previous.description ?? '');
      setReloadToken((t) => t + 1);
      toast.error(error instanceof Error ? error.message : 'Failed to update machine settings');
    } finally {
      setPendingSaves((n) => n - 1);
    }
  }

  function commitName() {
    if (!settings) return;
    const trimmed = nameDraft.trim();
    // An empty name is rejected server-side (name is the page title). Revert the
    // draft rather than firing a doomed PATCH.
    if (trimmed.length === 0) {
      setNameDraft(settings.name);
      return;
    }
    setNameDraft(trimmed);
    if (trimmed === settings.name) return;
    persist({ name: trimmed });
  }

  function commitDescription() {
    if (!settings) return;
    const trimmed = descriptionDraft.trim();
    setDescriptionDraft(trimmed);
    if (trimmed === (settings.description ?? '')) return;
    // Whitespace-only clears the description (round-trips to null server-side).
    persist({ description: trimmed.length === 0 ? null : trimmed });
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiDelete(`/api/machines/settings?machineId=${encodeURIComponent(machineId)}`);
      toast.success('Machine deleted');
      router.push(driveId ? `/dashboard/${driveId}` : '/dashboard');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete machine');
      setDeleting(false);
    }
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
        <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((t) => t + 1)}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-lg">General</CardTitle>
                <CardDescription>The Machine&apos;s name and description.</CardDescription>
              </div>
              {/* An in-flight save is surfaced, never enforced: disabling the
                  controls would swallow the very click that triggered the save
                  (a field's blur-commit fires before the mouseup lands on a
                  switch, so the switch would already be disabled). */}
              {pendingSaves > 0 && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving…
                </span>
              )}
            </div>
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
                onCheckedChange={(checked) => persist({ visibleToGlobalAssistant: checked })}
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
                onCheckedChange={(checked) => persist({ allowPageAgents: checked })}
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
            <AlertDialog>
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
