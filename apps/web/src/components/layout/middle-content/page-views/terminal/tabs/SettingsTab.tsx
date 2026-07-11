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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // In-flight save COUNT, not a flag: a text field's blur-commit and a switch
  // click can be airborne at once, and a boolean would report "done" as soon as
  // the first of them settled. Mirrored into a ref because `persist`'s `finally`
  // has to read the CURRENT count, not the one closed over when it started.
  const [pendingSaves, setPendingSaves] = useState(0);
  const pendingSavesRef = useRef(0);
  const resyncWhenIdle = useRef(false);

  // Local drafts for the text fields — inputs stay editable per-keystroke and
  // only persist on blur (the toggles persist immediately).
  const [nameDraft, setNameDraft] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');

  // Last known SERVER value, used to tell a clean draft from a dirty one so a
  // refetch can adopt server truth for fields the user isn't editing without
  // stomping the one they are.
  const serverSettings = useRef<MachineSettings | null>(null);

  // Which machine's settings we currently hold. A `reloadToken` refetch of the
  // SAME machine (retry after a load error, resync after a failed save)
  // revalidates in place, so a failed toggle doesn't flash the whole form away
  // and back — but a different `machineId` must block on the spinner rather than
  // render the previous machine's settings as if they were this one's.
  const loadedFor = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const isNewMachine = loadedFor.current !== machineId;
    if (isNewMachine) {
      // Drop the previous machine's settings before loading a different one —
      // otherwise a FAILED load would fall through to rendering the old machine's
      // name/toggles under the new machine's identity. A resync owed to the machine
      // we're leaving is dropped with it, so it can't fire a spurious refetch once
      // an unrelated save on the NEW machine drains.
      setSettings(null);
      serverSettings.current = null;
      resyncWhenIdle.current = false;
    }
    // Spinner whenever we have nothing to show for THIS machine: a different
    // machine, or a retry after the error state. `serverSettings` moves in exact
    // lockstep with `settings` (both nulled above, both set on load, and `persist`
    // touches neither), so the ref answers "do we have anything to show?" without
    // reading state — reading it via a `setSettings` updater instead would be an
    // impure updater, which StrictMode replays at render time and which strands
    // `loading: true` after the load's `finally` has already cleared it.
    if (isNewMachine || serverSettings.current === null) setLoading(true);
    (async () => {
      try {
        const response = await fetchWithAuth(
          `/api/machines/settings?machineId=${encodeURIComponent(machineId)}`,
        );
        if (!response.ok) throw new Error('Failed to load machine settings');
        const json = (await response.json()) as { settings: MachineSettings };
        if (cancelled) return;
        const next = json.settings;
        const previousServer = serverSettings.current;
        loadedFor.current = machineId;
        serverSettings.current = next;
        setSettings(next);
        // Adopt the server value only for drafts the user has NOT touched since
        // we last saw the server. A resync fires while the tab is open, so blindly
        // reseeding would delete text mid-keystroke.
        setNameDraft((draft) => (previousServer === null || draft === previousServer.name ? next.name : draft));
        setDescriptionDraft((draft) =>
          previousServer === null || draft === (previousServer.description ?? '')
            ? next.description ?? ''
            : draft,
        );
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
   * Two rules make the failure path safe under CONCURRENT saves (a field's
   * blur-commit and a switch click can be in flight together):
   *
   *  1. Revert ONLY the keys this save owned. Reverting a whole snapshot would
   *     roll back an unrelated edit that landed while this one was in flight.
   *  2. Defer the resync until every save has drained. The local snapshot is only
   *     a GUESS at server truth (the request may have committed and then timed
   *     out), so a refetch is the authority — but a GET fired while another PATCH
   *     is still airborne reads pre-PATCH state and is then overwritten by it,
   *     stranding the very staleness the resync exists to fix.
   */
  async function persist(patch: MachineSettingsPatch) {
    if (!settings) return;
    const keys = Object.keys(patch) as (keyof MachineSettingsPatch)[];
    const revert: MachineSettingsPatch = {};
    for (const key of keys) Object.assign(revert, { [key]: settings[key] });

    // The machine this save belongs to. If the tab is showing a DIFFERENT machine
    // by the time the request settles, every write below would land on that
    // machine's form — reverting machine A's name into machine B's input, where
    // the next blur would rename B. Late results for a machine we've left are
    // dropped (the resync too: it would refetch the wrong machine).
    const forMachine = machineId;
    const isStale = () => loadedFor.current !== forMachine;

    setSettings((current) => (current ? { ...current, ...patch } : current));
    pendingSavesRef.current += 1;
    setPendingSaves(pendingSavesRef.current);
    try {
      await apiPatch('/api/machines/settings', { machineId: forMachine, ...patch });
    } catch (error) {
      if (isStale()) return;
      setSettings((current) => (current ? { ...current, ...revert } : current));
      if (revert.name !== undefined) setNameDraft(revert.name);
      if (revert.description !== undefined) setDescriptionDraft(revert.description ?? '');
      resyncWhenIdle.current = true;
      toast.error(error instanceof Error ? error.message : 'Failed to update machine settings');
    } finally {
      pendingSavesRef.current -= 1;
      setPendingSaves(pendingSavesRef.current);
      if (!isStale() && pendingSavesRef.current === 0 && resyncWhenIdle.current) {
        resyncWhenIdle.current = false;
        setReloadToken((t) => t + 1);
      }
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
        <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((t) => t + 1)}>
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
