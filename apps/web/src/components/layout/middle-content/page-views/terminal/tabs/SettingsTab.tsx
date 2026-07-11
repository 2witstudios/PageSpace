"use client";

import { useEffect, useState } from 'react';
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Local drafts for the text fields — inputs stay editable per-keystroke and
  // only persist on blur (the toggles persist immediately). Seeded from the
  // server on load, and otherwise only ever written back by a failed save's
  // rollback, so an in-flight request can never clobber what the user is typing.
  const [nameDraft, setNameDraft] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    (async () => {
      try {
        const response = await fetchWithAuth(
          `/api/machines/settings?machineId=${encodeURIComponent(machineId)}`,
        );
        if (!response.ok) throw new Error('Failed to load machine settings');
        const json = (await response.json()) as { settings: MachineSettings };
        if (!cancelled) {
          setSettings(json.settings);
          setNameDraft(json.settings.name);
          setDescriptionDraft(json.settings.description ?? '');
        }
      } catch (error) {
        console.error('Failed to load machine settings:', error);
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load machine settings');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId, reloadToken]);

  /**
   * Optimistically apply `patch`, PATCH it, and roll back ONLY the patched keys
   * on failure (toasting the error).
   *
   * We deliberately do NOT reconcile from the server's response body. The route
   * echoes the whole `MachineSettings`, so applying it would clobber a field the
   * user is concurrently editing with a value that was already stale when the
   * request left. Every field we send is normalized client-side exactly as the
   * route normalizes it (name trimmed; blank description → null), so the
   * optimistic value and the persisted value never diverge. Rolling back only the
   * patched keys — rather than restoring a whole snapshot — keeps a failed toggle
   * from reverting an unrelated edit that landed while it was in flight.
   */
  async function persist(patch: MachineSettingsPatch) {
    if (!settings) return;
    const rollback: MachineSettingsPatch = {};
    for (const key of Object.keys(patch) as (keyof MachineSettingsPatch)[]) {
      Object.assign(rollback, { [key]: settings[key] });
    }
    setSettings((current) => (current ? { ...current, ...patch } : current));
    setSaving(true);
    try {
      await apiPatch('/api/machines/settings', { machineId, ...patch });
    } catch (error) {
      setSettings((current) => (current ? { ...current, ...rollback } : current));
      if (rollback.name !== undefined) setNameDraft(rollback.name);
      if (rollback.description !== undefined) setDescriptionDraft(rollback.description ?? '');
      toast.error(error instanceof Error ? error.message : 'Failed to update machine settings');
    } finally {
      setSaving(false);
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

  if (loadError || !settings) {
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
                  controls here would swallow the very click that triggered the
                  save (a field's blur-commit fires before the mouseup that lands
                  on a switch, so the switch would already be disabled). */}
              {saving && (
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
                <Button type="button" variant="destructive" disabled={deleting}>
                  {deleting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
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
                  <AlertDialogAction
                    onClick={handleDelete}
                    disabled={deleting}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete Machine
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
