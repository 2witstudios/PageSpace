'use client';

import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Copy, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import useSWR from 'swr';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { fetchWithAuth, post, patch, del } from '@/lib/auth/auth-fetch';

interface WebhookRow {
  id: string;
  name: string;
  webhookToken: string;
  isEnabled: boolean;
  lastFiredAt: string | null;
  lastFireError: string | null;
}

interface PageWebhooksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageId: string;
  pageType: string;
}

/** pageId is the ORIGINATING page — the reveal panel only renders when it matches the dialog's current page. */
type RevealedSecret = { pageId: string; webhookUrl: string; secret: string };

// Holding pen for one-time secrets whose create/rotate response landed after
// this page's dialog unmounted (CenterPanel remounts views by page id on
// navigation). Rotate has already invalidated the predecessor server-side, so
// each response is the only plaintext copy — parked here in arrival order,
// keyed by page, and consumed one at a time by that page's dialog.
const orphanedReveals = new Map<string, RevealedSecret[]>();

// The pen is module state, so parking must notify any mounted dialog — a
// version counter via useSyncExternalStore re-runs the pickup effect.
let orphanVersion = 0;
const orphanListeners = new Set<() => void>();
const subscribeOrphans = (listener: () => void) => {
  orphanListeners.add(listener);
  return () => { orphanListeners.delete(listener); };
};
const getOrphanVersion = () => orphanVersion;

const parkOrphan = (value: RevealedSecret) => {
  const queue = orphanedReveals.get(value.pageId) ?? [];
  queue.push(value);
  orphanedReveals.set(value.pageId, queue);
  orphanVersion += 1;
  orphanListeners.forEach((listener) => listener());
};

// Webhook ids with a rotation in flight, across component instances. Client
// issuance order cannot establish DB commit order, so a second concurrent
// rotation of the same webhook would make it unknowable which response's
// secret is live — a new rotation is refused until the pending one settles.
// (Other browsers/admins are covered by the server's 409 optimistic guard.)
const rotatingWebhooks = new Set<string>();

const webhooksFetcher = async (url: string): Promise<{ webhooks: WebhookRow[] } | { error: string; status: number }> => {
  const res = await fetchWithAuth(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error ?? 'Failed to load webhooks', status: res.status };
  return body;
};

function PageWebhooksDialogImpl({ open, onOpenChange, pageId, pageType }: PageWebhooksDialogProps) {
  const key = open ? `/api/pages/${pageId}/webhooks` : null;
  const { data, isLoading, mutate: refetch } = useSWR(key, webhooksFetcher, { revalidateOnFocus: false });

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // Two independent locks: busyId covers row edits (toggle/delete); mintingId
  // covers the secret-producing rotation. They must not share state — a
  // toggle/delete settling mid-rotation would otherwise clear the shared lock
  // and let a second one-time secret race for the single reveal slot.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mintingId, setMintingId] = useState<string | null>(null);
  const [confirmRotateId, setConfirmRotateId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const orphanSignal = useSyncExternalStore(subscribeOrphans, getOrphanVersion, getOrphanVersion);

  // Routes a fresh one-time secret to the live dialog, or parks it in the
  // orphan pen when the response outlived this component instance. `pageId` in
  // the closure is the page the request was started on — the same instance may
  // meanwhile be showing a different page (CenterPanel reuses views across
  // page ids), which the render gate below handles.
  const reveal = (webhook: WebhookRow, secret: string) => {
    const value: RevealedSecret = {
      pageId,
      webhookUrl: `${window.location.origin}/api/webhooks/${webhook.webhookToken}`,
      secret,
    };
    if (!mountedRef.current) {
      parkOrphan(value);
      return;
    }
    setRevealed(value);
  };

  // Never show a secret in another page's dialog: only a reveal minted for the
  // current page renders; one that belongs elsewhere is parked for that page.
  const activeReveal = revealed && revealed.pageId === pageId ? revealed : null;
  useEffect(() => {
    if (revealed && revealed.pageId !== pageId) {
      parkOrphan(revealed);
      setRevealed(null);
    }
  }, [revealed, pageId]);

  useEffect(() => {
    if (!open) {
      // Clears the secret from state on close — but deliberately does NOT
      // cancel an in-flight create/rotate: its response holds the only copy of
      // a one-time secret (rotate has already invalidated the old one), so a
      // late resolution repopulates `revealed` and the reopened dialog shows
      // the secret once instead of silently losing it.
      setRevealed(null);
      setNewName('');
      return;
    }
    // Open with no reveal showing: deliver the next parked secret, if any.
    // Re-runs when a reveal is dismissed or a new orphan is parked
    // (orphanSignal), so queued secrets surface one at a time.
    if (revealed) return;
    const queue = orphanedReveals.get(pageId);
    const next = queue?.shift();
    if (queue && queue.length === 0) orphanedReveals.delete(pageId);
    if (next) setRevealed(next);
  }, [open, pageId, revealed, orphanSignal]);

  const errorStatus = data && 'error' in data ? data.status : null;
  const forbidden = errorStatus === 403;
  const loadFailed = errorStatus !== null && errorStatus !== 403;
  const webhooks = data && 'webhooks' in data ? data.webhooks : [];

  const createWebhook = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await post<{ webhook: WebhookRow; webhookSecret: string }>(
        `/api/pages/${pageId}/webhooks`,
        { name },
      );
      setNewName('');
      // Reveal before refreshing the list: the secret exists only in this
      // response, so a failed (cosmetic) revalidation must never discard it.
      reveal(res.webhook, res.webhookSecret);
      await refetch().catch(() => {});
    } catch {
      toast.error('Failed to create webhook');
    } finally {
      setCreating(false);
    }
  };

  const toggleWebhook = async (id: string, enabled: boolean) => {
    setBusyId(id);
    try {
      await patch(`/api/pages/${pageId}/webhooks/${id}`, { isEnabled: enabled });
      await refetch();
    } catch {
      toast.error('Failed to update webhook');
    } finally {
      setBusyId(null);
    }
  };

  const rotateWebhook = async (id: string) => {
    if (rotatingWebhooks.has(id)) {
      toast.error('A rotation of this webhook is still in progress — wait for its secret before starting another');
      return;
    }
    rotatingWebhooks.add(id);
    setMintingId(id);
    try {
      const res = await post<{ webhook: WebhookRow; webhookSecret: string }>(
        `/api/pages/${pageId}/webhooks/${id}/rotate`,
      );
      // Reveal before refreshing the list: the old secret is already dead and
      // this response holds the only copy of the new one — a failed (cosmetic)
      // revalidation must never discard it.
      reveal(res.webhook, res.webhookSecret);
      await refetch().catch(() => {});
    } catch (error) {
      // The rotate route's error bodies are user-actionable (e.g. "rotated by a
      // concurrent request") — surface them instead of a generic failure.
      toast.error(error instanceof Error && error.message ? error.message : 'Failed to rotate secret');
    } finally {
      rotatingWebhooks.delete(id);
      setMintingId(null);
    }
  };

  const removeWebhook = async (id: string) => {
    setBusyId(id);
    try {
      await del(`/api/pages/${pageId}/webhooks/${id}`);
      await refetch();
    } catch {
      toast.error('Failed to delete webhook');
    } finally {
      setBusyId(null);
    }
  };

  const copyRevealed = async () => {
    if (!activeReveal) return;
    await navigator.clipboard.writeText(`${activeReveal.webhookUrl}\n${activeReveal.secret}`);
    toast.success('Copied to clipboard');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg flex flex-col max-h-[85vh]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Webhook className="h-4 w-4" />
            Incoming Webhooks
          </DialogTitle>
          <DialogDescription>
            {/* CHANNEL is the one type with a default delivery action today — the same
                special case the intake route carries until the dispatch map lands. */}
            {pageType === 'CHANNEL'
              ? 'External systems can post messages into this channel by sending signed requests to a webhook URL.'
              : 'External systems can push events to this page by sending signed requests to a webhook URL.'}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : forbidden ? (
          <p className="text-sm text-muted-foreground py-4">
            Only this drive&apos;s owner or an admin can manage webhooks.
          </p>
        ) : loadFailed ? (
          <div className="flex items-center justify-between gap-2 py-4">
            <p className="text-sm text-muted-foreground">Failed to load webhooks.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : activeReveal ? (
          <div className="space-y-3 py-2">
            <p className="text-sm">
              Save this secret now — it won&apos;t be shown again. Configure your system to POST to the URL below,
              signed with the secret (see docs for the signature scheme).
            </p>
            <div className="rounded-md border bg-muted p-3 space-y-1 text-xs font-mono break-all">
              <div>{activeReveal.webhookUrl}</div>
              <div>{activeReveal.secret}</div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={copyRevealed}>
                <Copy className="h-3.5 w-3.5 mr-1" /> Copy
              </Button>
              <Button type="button" size="sm" onClick={() => setRevealed(null)}>
                <Check className="h-3.5 w-3.5 mr-1" /> Done, I&apos;ve saved it
              </Button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-1">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void createWebhook();
              }}
            >
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Webhook name (e.g. Deploys)"
                maxLength={80}
              />
              <Button
                type="submit"
                size="sm"
                disabled={creating || mintingId !== null || newName.trim().length === 0}
              >
                {creating ? 'Creating…' : 'Create webhook'}
              </Button>
            </form>

            {webhooks.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No webhooks yet — create one to let an external system (CI, monitoring, a script) send
                events to this page.
              </p>
            ) : (
              <div className="space-y-2">
                {webhooks.map((webhook) => (
                  <div key={webhook.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                    <div className="min-w-0">
                      <span className="font-medium text-sm truncate block">{webhook.name}</span>
                      <span className="text-xs font-mono text-muted-foreground truncate block">
                        …{webhook.webhookToken.slice(-8)}
                      </span>
                      {webhook.lastFireError && (
                        <p className="text-xs text-destructive mt-1">Last delivery failed: {webhook.lastFireError}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Switch
                        checked={webhook.isEnabled}
                        disabled={busyId === webhook.id || mintingId === webhook.id}
                        onCheckedChange={(checked) => toggleWebhook(webhook.id, checked)}
                      />
                      {/* Any-minting, not row-busy: two in-flight secret mints would
                          race for the single reveal slot and one one-time secret
                          would be lost — no new secret may start while one is being
                          minted anywhere in this dialog. */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={mintingId !== null || creating}
                        onClick={() => setConfirmRotateId(webhook.id)}
                      >
                        Rotate secret
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busyId === webhook.id || mintingId === webhook.id}
                        onClick={() => removeWebhook(webhook.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>

        <AlertDialog open={confirmRotateId !== null} onOpenChange={(o) => { if (!o) setConfirmRotateId(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Rotate this webhook&apos;s secret?</AlertDialogTitle>
              <AlertDialogDescription>
                The current secret stops working immediately — deliveries signed with it are rejected
                until your external sender is updated with the new secret. The webhook URL stays the
                same, and the new secret is shown exactly once.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const id = confirmRotateId;
                  setConfirmRotateId(null);
                  if (id) void rotateWebhook(id);
                }}
              >
                Rotate
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

// Memoized: AiChatView re-renders per streaming token, and every prop here is
// stable/primitive — memo skips the closed dialog's subtree on all of them.
export const PageWebhooksDialog = memo(PageWebhooksDialogImpl);
