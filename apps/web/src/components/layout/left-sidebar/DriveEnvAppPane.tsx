'use client';

/**
 * The published-app cockpit for one environment — publish, status, live URL,
 * logs, and the stop/resume/unpublish verbs. It lives ON the environment row
 * (see the task's own requirement: no separate "published apps" dashboard),
 * rendered as an expandable sub-section beneath `DriveEnvRow`'s session list.
 *
 * Read/write split: any drive member sees status/URL/logs; publish, stop,
 * resume and unpublish are OWNER/ADMIN only (`canManage`, the same flag that
 * already gates rename/rebuild/delete on the row above). Buying or cancelling
 * the always-on tier is stricter still — OWNER only (`isOwner`) — because that
 * spends the drive's money, not just its compute.
 *
 * Gated on `useAppHostingCapability()`: this entire pane renders NOTHING on a
 * deployment where `APP_HOSTING_ENABLED` is off (the default everywhere). A
 * visible Publish button whose click 404s is worse than no button — a dark
 * feature must read as absent, not broken.
 */

import { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Rocket, Square, Play, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import useSWR from 'swr';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { post, del, ApiRequestError } from '@/lib/auth/auth-fetch';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useDriveEnvApp, type DriveEnvAppDTO, type PublishedAppStatus } from '@/hooks/drive-envs/useDriveEnvApp';
import { useAppLogs } from '@/hooks/drive-envs/useAppLogs';
import { useAppHostingCapability } from '@/hooks/drive-envs/useAppHostingCapability';
import { useEditingSession } from '@/stores/useEditingSession';
import { StripeProvider } from '@/components/billing/StripeProvider';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';

const STATUS_COPY: Record<PublishedAppStatus, { label: string; tone: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  provisioning: { label: 'Provisioning…', tone: 'secondary' },
  building: { label: 'Building…', tone: 'secondary' },
  deploying: { label: 'Deploying…', tone: 'secondary' },
  running: { label: 'Live', tone: 'default' },
  stopped: { label: 'Stopped (wakes on visit)', tone: 'outline' },
  parked: { label: 'Paused — needs credits or a resume', tone: 'destructive' },
  destroying: { label: 'Unpublishing…', tone: 'secondary' },
  failed: { label: 'Failed', tone: 'destructive' },
};

/**
 * Falls back rather than crashing on a status this build doesn't know about
 * yet — the `published_app_status` enum can grow a value before every reader
 * of it is updated, and an undefined lookup here must never white-screen the
 * sidebar.
 */
export function statusCopyFor(status: PublishedAppStatus): { label: string; tone: 'default' | 'secondary' | 'destructive' | 'outline' } {
  return STATUS_COPY[status] ?? { label: status, tone: 'outline' };
}

function appPath(driveId: string, envId: string): string {
  return `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(envId)}/app`;
}

export function DriveEnvAppPane({
  driveId,
  envId,
  envName,
  canManage,
  isOwner,
}: {
  driveId: string;
  envId: string;
  envName: string;
  canManage: boolean;
  /** May spend this drive's money — gates the dedicated-tier buy/cancel affordance, stricter than `canManage`. */
  isOwner: boolean;
}) {
  const appHostingEnabled = useAppHostingCapability();
  const [expanded, setExpanded] = useState(false);
  const { app, isLoading, mutate } = useDriveEnvApp(driveId, envId, { enabled: expanded });
  const [publishing, setPublishing] = useState(false);
  const [actioning, setActioning] = useState(false);
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  useEditingSession(`drive-env-app-unpublish-${envId}`, confirmingUnpublish, 'form', {
    componentName: 'DriveEnvAppPane.unpublishDialog',
  });

  const path = appPath(driveId, envId);

  const publish = useCallback(async () => {
    setPublishing(true);
    try {
      await post(path);
      toast.success(`Publishing “${envName}”…`);
    } catch (error) {
      toast.error('Could not publish this environment', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setPublishing(false);
      mutate();
    }
  }, [path, envName, mutate]);

  const runAction = useCallback(
    async (action: 'stop' | 'resume') => {
      setActioning(true);
      try {
        await post(`${path}/actions`, { action });
      } catch (error) {
        toast.error(action === 'stop' ? 'Could not stop the app' : 'Could not resume the app', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      } finally {
        setActioning(false);
        mutate();
      }
    },
    [path, mutate],
  );

  const unpublish = useCallback(async () => {
    setActioning(true);
    try {
      await del(path);
      toast.success(`Unpublished “${envName}”`);
    } catch (error) {
      toast.error('Could not unpublish this app', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setActioning(false);
      setConfirmingUnpublish(false);
      mutate();
    }
  }, [path, envName, mutate]);

  // `undefined` while the capability is still loading, `false` once it's
  // confirmed off — both render nothing, so a dark deployment never flashes
  // the pane before settling, and an enabled one only pays the extra request
  // once (SWR dedupes it across every row).
  if (appHostingEnabled !== true) return null;

  return (
    <div className="ml-4 border-l border-border pl-1.5">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Rocket className="size-3" aria-hidden="true" />
        <span>Published app</span>
        {app && (
          <Badge variant={statusCopyFor(app.status).tone} className="ml-auto text-[10px]">
            {statusCopyFor(app.status).label}
          </Badge>
        )}
      </button>

      {expanded && (
        <div className="space-y-2 px-2 py-1.5 text-xs">
          {isLoading && <div className="text-muted-foreground">Loading…</div>}

          {!isLoading && !app && (
            canManage ? (
              <Button size="sm" variant="outline" disabled={publishing} onClick={() => void publish()}>
                {publishing ? 'Publishing…' : 'Publish'}
              </Button>
            ) : (
              <div className="text-muted-foreground">Not published yet.</div>
            )
          )}

          {app && (
            <AppPaneBody
              app={app}
              canManage={canManage}
              isOwner={isOwner}
              actioning={actioning}
              onPublishAgain={publish}
              onStop={() => void runAction('stop')}
              onResume={() => void runAction('resume')}
              onUnpublish={() => setConfirmingUnpublish(true)}
              logsOpen={logsOpen}
              onToggleLogs={() => setLogsOpen((value) => !value)}
              driveId={driveId}
              envId={envId}
            />
          )}
        </div>
      )}

      <AlertDialog open={confirmingUnpublish} onOpenChange={setConfirmingUnpublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpublish “{envName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The live URL stops resolving and the app's hosting is torn down, including any
              always-on subscription. The environment itself — its filesystem and sessions — is
              untouched, and you can publish it again any time. This cannot be undone for the app
              that is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actioning}>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={actioning} onClick={() => void unpublish()}>
              {actioning ? 'Unpublishing…' : 'Unpublish (delete app)'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AppPaneBody({
  app,
  canManage,
  isOwner,
  actioning,
  onPublishAgain,
  onStop,
  onResume,
  onUnpublish,
  logsOpen,
  onToggleLogs,
  driveId,
  envId,
}: {
  app: DriveEnvAppDTO;
  canManage: boolean;
  isOwner: boolean;
  actioning: boolean;
  onPublishAgain: () => void;
  onStop: () => void;
  onResume: () => void;
  onUnpublish: () => void;
  logsOpen: boolean;
  onToggleLogs: () => void;
  driveId: string;
  envId: string;
}) {
  const lines = useAppLogs(logsOpen ? envId : null, logsOpen ? app.flyAppName : null);

  return (
    <div className="space-y-2">
      {app.status === 'running' && (
        <a
          href={app.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 truncate text-foreground underline-offset-2 hover:underline"
        >
          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{app.subdomain}</span>
        </a>
      )}

      {app.status === 'parked' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive">
          Paused — this app ran out of credits or hit its daily limit. Top up credits or switch to the
          always-on plan below, then resume it.
        </div>
      )}

      {app.status === 'failed' && app.lastError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive">
          {app.lastError}
        </div>
      )}

      <div className="text-muted-foreground">Tier: {app.tier === 'dedicated' ? 'Always-on' : 'Metered (pay per awake time)'}</div>

      {canManage && (
        <div className="flex flex-wrap gap-1.5">
          {(app.status === 'stopped' || app.status === 'parked') && (
            <Button size="sm" variant="outline" disabled={actioning} onClick={onResume}>
              <Play className="mr-1 size-3" /> Resume
            </Button>
          )}
          {app.status === 'running' && (
            <Button size="sm" variant="outline" disabled={actioning} onClick={onStop}>
              <Square className="mr-1 size-3" /> Stop
            </Button>
          )}
          {app.status === 'failed' && (
            <Button size="sm" variant="outline" disabled={actioning} onClick={onPublishAgain}>
              <Rocket className="mr-1 size-3" /> Retry publish
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={actioning} onClick={onUnpublish}>
            <Trash2 className="mr-1 size-3" /> Unpublish
          </Button>
        </div>
      )}

      <DedicatedTierSection app={app} isOwner={isOwner} driveId={driveId} envId={envId} />

      <div>
        <button
          type="button"
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={onToggleLogs}
        >
          {logsOpen ? 'Hide logs' : 'Show logs'}
        </button>
        {logsOpen && (
          <div className="mt-1 max-h-40 overflow-y-auto rounded-md bg-muted/50 p-1.5 font-mono text-[10px] leading-4">
            {lines.length === 0 && <div className="text-muted-foreground">No log lines yet.</div>}
            {lines.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-all">
                {line.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface DunningState {
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string;
}

async function dunningFetcher(url: string): Promise<{ subscription: DunningState | null; purchasable: boolean }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error('Failed to load subscription state');
  return response.json();
}

/**
 * Buy/cancel the flat always-on SKU, and show the dunning state honestly
 * rather than hiding a payment problem.
 *
 * Gated on `isOwner`, NOT `canManage` — spending the drive's money is a
 * stricter question than managing its published app, mirroring the backend
 * `/dedicated` route's own owner-direct check (it deliberately does not use
 * `isPrincipalDriveOwnerOrAdmin`).
 */
function DedicatedTierSection({
  app,
  isOwner,
  driveId,
  envId,
}: {
  app: DriveEnvAppDTO;
  isOwner: boolean;
  driveId: string;
  envId: string;
}) {
  const [starting, setStarting] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);

  // Fetched regardless of tier (not just when already `dedicated`): the
  // metered case needs `purchasable` too, to decide whether the "Buy
  // always-on" button should even render.
  const { data } = useSWR<{ subscription: DunningState | null; purchasable: boolean }>(
    isOwner ? `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(envId)}/app/dunning` : null,
    dunningFetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const startDedicated = useCallback(async () => {
    setStarting(true);
    try {
      const response = await post<{ clientSecret: string }>(`/api/app-hosting/apps/${encodeURIComponent(app.id)}/dedicated`);
      setClientSecret(response.clientSecret);
    } catch (error) {
      toast.error('Could not start the always-on plan', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setStarting(false);
    }
  }, [app.id]);

  const cancelDedicated = useCallback(async () => {
    try {
      await del(`/api/app-hosting/apps/${encodeURIComponent(app.id)}/dedicated`);
      toast.success('Always-on plan will cancel at the end of the billing period');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        toast.error('No always-on subscription to cancel');
        return;
      }
      toast.error('Could not cancel the always-on plan', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    }
  }, [app.id]);

  useEditingSession(`drive-env-app-dedicated-checkout-${app.id}`, clientSecret !== null, 'form', {
    componentName: 'DriveEnvAppPane.dedicatedCheckout',
  });

  if (!isOwner) return null;
  // `undefined` (still loading) renders nothing rather than a button that
  // might immediately need to disappear — same "don't flash a dead control"
  // reasoning as the pane-level capability gate.
  const purchasable = data?.purchasable;

  return (
    <div className="space-y-1.5 border-t border-border pt-1.5">
      {app.tier === 'metered' && purchasable === true && !clientSecret && (
        <Button size="sm" variant="outline" disabled={starting} onClick={() => void startDedicated()}>
          {starting ? 'Starting…' : 'Buy always-on'}
        </Button>
      )}
      {clientSecret && (
        <StripeProvider options={{ clientSecret }}>
          <DedicatedCheckoutForm onDone={() => setClientSecret(null)} />
        </StripeProvider>
      )}
      {app.tier === 'dedicated' && (
        <>
          {data?.subscription?.status === 'past_due' && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-amber-700 dark:text-amber-400">
              Payment failed — update your card in Billing to keep this app always-on.
            </div>
          )}
          {data?.subscription?.cancelAtPeriodEnd ? (
            <div className="text-muted-foreground">
              Cancels at the end of the billing period ({new Date(data.subscription.currentPeriodEnd).toLocaleDateString()}).
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void cancelDedicated()}>
              Cancel always-on (at period end)
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function DedicatedCheckoutForm({ onDone }: { onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);

  const confirm = useCallback(async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);
    const { error } = await stripe.confirmPayment({ elements, redirect: 'if_required' });
    setSubmitting(false);
    if (error) {
      toast.error('Payment could not be confirmed', { description: error.message });
      return;
    }
    toast.success('Always-on plan started');
    onDone();
  }, [stripe, elements, onDone]);

  return (
    <div className="space-y-1.5">
      <PaymentElement />
      <Button size="sm" disabled={submitting} onClick={() => void confirm()}>
        {submitting ? 'Confirming…' : 'Confirm payment'}
      </Button>
    </div>
  );
}
