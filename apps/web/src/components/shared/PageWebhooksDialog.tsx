'use client';

import { memo, useEffect, useState } from 'react';
import { Check, Copy, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import useSWR from 'swr';
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ webhookUrl: string; secret: string } | null>(null);

  useEffect(() => {
    if (!open) {
      setRevealed(null);
      setNewName('');
    }
  }, [open]);

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
      setRevealed({
        webhookUrl: `${window.location.origin}/api/webhooks/${res.webhook.webhookToken}`,
        secret: res.webhookSecret,
      });
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
    setBusyId(id);
    try {
      const res = await post<{ webhook: WebhookRow; webhookSecret: string }>(
        `/api/pages/${pageId}/webhooks/${id}/rotate`,
      );
      // Reveal before refreshing the list: the old secret is already dead and
      // this response holds the only copy of the new one — a failed (cosmetic)
      // revalidation must never discard it.
      setRevealed({
        webhookUrl: `${window.location.origin}/api/webhooks/${res.webhook.webhookToken}`,
        secret: res.webhookSecret,
      });
      await refetch().catch(() => {});
    } catch (error) {
      // The rotate route's error bodies are user-actionable (e.g. "rotated by a
      // concurrent request") — surface them instead of a generic failure.
      toast.error(error instanceof Error && error.message ? error.message : 'Failed to rotate secret');
    } finally {
      setBusyId(null);
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
    if (!revealed) return;
    await navigator.clipboard.writeText(`${revealed.webhookUrl}\n${revealed.secret}`);
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
        ) : revealed ? (
          <div className="space-y-3 py-2">
            <p className="text-sm">
              Save this secret now — it won&apos;t be shown again. Configure your system to POST to the URL below,
              signed with the secret (see docs for the signature scheme).
            </p>
            <div className="rounded-md border bg-muted p-3 space-y-1 text-xs font-mono break-all">
              <div>{revealed.webhookUrl}</div>
              <div>{revealed.secret}</div>
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
                disabled={creating || busyId !== null || newName.trim().length === 0}
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
                        disabled={busyId === webhook.id}
                        onCheckedChange={(checked) => toggleWebhook(webhook.id, checked)}
                      />
                      {/* Any-busy, not row-busy: two in-flight rotations would race
                          for the single reveal slot and one one-time secret would be
                          lost — no new secret may start while one is being minted. */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busyId !== null || creating}
                        onClick={() => rotateWebhook(webhook.id)}
                      >
                        Rotate secret
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busyId === webhook.id}
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
      </DialogContent>
    </Dialog>
  );
}

// Memoized: AiChatView re-renders per streaming token, and every prop here is
// stable/primitive — memo skips the closed dialog's subtree on all of them.
export const PageWebhooksDialog = memo(PageWebhooksDialogImpl);
