'use client';

import { useState } from 'react';
import { EyeOff, Search } from 'lucide-react';
import type { ResolvedTarget } from '@pagespace/lib/content-safety/targets';
import type { TakedownRequest } from '@pagespace/lib/content-safety/takedown-request';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DataState } from '@/components/admin/kit';
import { useAdminQuery } from '@/hooks/use-admin-query';
import type { CaseSummary } from '@/lib/content/case-summary';
import { describeTakedownResult, runTakedown } from './actions';
import { CaseList, Mono } from './case-list';
import { TakedownDialog, type TakedownCategory, type TakedownDialogValues } from './takedown-dialog';

interface ResolveResponse {
  target: ResolvedTarget;
  cases: CaseSummary[];
}

type ActionKind = 'global' | 'unpublish_page' | 'park_drive' | 'avatar';

const GLOBAL_CATEGORIES: readonly TakedownCategory[] = ['csam', 'malware', 'illegal_other'];
const ALL_CATEGORIES: readonly TakedownCategory[] = ['csam', 'malware', 'illegal_other', 'policy'];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function IdList({ ids }: { ids: string[] }) {
  if (ids.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <ul className="space-y-0.5">
      {ids.map((id) => (
        <li key={id}><Mono>{id}</Mono></li>
      ))}
    </ul>
  );
}

/**
 * Look up a takedown target and act on it.
 *
 * This panel shows METADATA ONLY. It must never render the file: no preview,
 * no thumbnail, no image element, and no link to the file or to the published
 * page. An admin has to be able to act on suspected CSAM without seeing it —
 * IDs, hashes and URLs appear here as inert monospace text and nothing else.
 */
export function TargetPanel() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const url = query ? `/api/admin/content/resolve?q=${encodeURIComponent(query)}` : null;
  const { data, isLoading, error, refetch } = useAdminQuery<ResolveResponse>(url);

  const [dialog, setDialog] = useState<ActionKind | null>(null);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; ok: boolean } | null>(null);

  // Only show a result that belongs to the current query: useAdminQuery keeps the previous data while it refetches.
  const target = query && data ? data.target : null;
  const cases = query && data ? data.cases : [];
  const refs = target?.references ?? null;

  const open = (kind: ActionKind) => {
    setDialogError(null);
    setDialog(kind);
  };

  const submit = async (request: TakedownRequest, close: () => void) => {
    setPending(true);
    setDialogError(null);
    try {
      setNotice(describeTakedownResult(await runTakedown(request)));
      close();
      refetch();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setPending(false);
    }
  };

  const buildRequest = (kind: ActionKind, values: TakedownDialogValues): TakedownRequest | null => {
    if (!target) return null;
    const { category, reason } = values;
    switch (kind) {
      case 'global':
        if (!target.contentHash || category === 'policy') return null;
        return {
          action: 'global',
          contentHash: target.contentHash,
          category,
          reason,
          suspendUploader: values.suspendUploader,
          ...(values.skipPreservation
            ? { skipPreservation: true, skipPreservationReason: values.skipPreservationReason }
            : {}),
        };
      case 'unpublish_page':
        return target.page ? { action: 'unpublish_page', pageId: target.page.id, category, reason } : null;
      case 'park_drive':
        return target.drive ? { action: 'park_drive', driveId: target.drive.id, category, reason } : null;
      case 'avatar':
        return target.user ? { action: 'avatar', userId: target.user.id, category, reason } : null;
    }
  };

  const DIALOGS: Record<ActionKind, { title: string; description: React.ReactNode; confirmLabel: string }> = {
    global: {
      title: 'Take this content down everywhere?',
      description: (
        <span>
          Blocks the hash, preserves a copy, then deletes the bytes from private storage and from every published
          site. Storage is shared by hash, so this removes the file for <strong>every</strong> account that has
          it. It cannot be undone.
        </span>
      ),
      confirmLabel: 'Take down everywhere',
    },
    unpublish_page: {
      title: 'Unpublish this page?',
      description: (
        <span>
          Removes the page from the web. The file itself is not deleted or blocked, and identical files in other
          accounts are untouched. The author can publish it again.
        </span>
      ),
      confirmLabel: 'Unpublish page',
    },
    park_drive: {
      title: "Park every published site in this drive?",
      description: (
        <span>
          Takes the drive&rsquo;s subdomain and custom domains off the web and holds them: nothing can be published
          to them again until the hold is lifted. No content is deleted.
        </span>
      ),
      confirmLabel: 'Park sites',
    },
    avatar: {
      title: "Remove this user's avatar?",
      description: (
        <span>
          Deletes the uploaded avatar image and clears it from their profile. An external image from a sign-in
          provider is not ours to delete, but stops being shown. Copies already cached by browsers or a CDN may
          persist until those caches expire.
        </span>
      ),
      confirmLabel: 'Remove avatar',
    },
  };

  return (
    <div className="space-y-6">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setNotice(null);
          setQuery(input.trim());
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Content hash, file ID, page ID, published URL or user ID"
          className="max-w-2xl font-mono text-xs"
          aria-label="Takedown target"
        />
        <Button type="submit" disabled={!input.trim()}>
          <Search className="mr-2 h-4 w-4" /> Look up
        </Button>
      </form>

      <Alert>
        <EyeOff className="h-4 w-4" />
        <AlertTitle>The file is never shown here</AlertTitle>
        <AlertDescription>
          This console shows identifiers and counts only. There is no preview, thumbnail or link to the file, by
          design. Do not open reported material to check it; follow the runbook.
        </AlertDescription>
      </Alert>

      {notice && (
        <p className={`text-sm ${notice.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}`} role="status">
          {notice.message}
        </p>
      )}

      {query && (
        <DataState isLoading={isLoading} error={error} onRetry={refetch} hasData={!!target}>
          {target && (
            <div className="space-y-6">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Target</CardTitle>
                    <CardDescription>{target.targetType.replace('_', ' ')}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <dl className="space-y-2">
                      <Field label="ID"><Mono>{target.targetId}</Mono></Field>
                      <Field label="Content hash">
                        {target.contentHash ? <Mono>{target.contentHash}</Mono> : <span className="text-muted-foreground">none</span>}
                      </Field>
                      <Field label="Blocklist">
                        {target.block ? (
                          <span>
                            <Badge variant="destructive">Blocked: {target.block.category}</Badge>
                            <span className="ml-2 text-xs text-muted-foreground">
                              since {new Date(target.block.createdAt).toLocaleString()}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">not blocked</span>
                        )}
                      </Field>
                      {target.page && (
                        <>
                          <Field label="Page"><Mono>{target.page.id}</Mono></Field>
                          <Field label="Page type">
                            {target.page.type}
                            {target.page.mimeType ? ` (${target.page.mimeType})` : ''}
                            {target.page.isTrashed ? ', in trash' : ''}
                          </Field>
                          <Field label="Published">{target.page.isPublished ? 'Yes' : 'No'}</Field>
                        </>
                      )}
                      {target.drive && (
                        <>
                          <Field label="Drive"><Mono>{target.drive.id}</Mono></Field>
                          <Field label="Drive owner"><Mono>{target.drive.ownerId}</Mono></Field>
                          <Field label="Organization">
                            {target.drive.orgId ? <Mono>{target.drive.orgId}</Mono> : <span className="text-muted-foreground">personal drive</span>}
                          </Field>
                          <Field label="Published sites">
                            {target.drive.sitesHeld ? (
                              <span>
                                <Badge variant="destructive">Parked and held</Badge>
                                <span className="ml-2 text-xs text-muted-foreground">
                                  Lift a hold from the case that placed it (look up the drive ID to see its cases).
                                </span>
                              </span>
                            ) : target.drive.publishes ? 'Live' : 'None'}
                          </Field>
                        </>
                      )}
                      {target.user && (
                        <>
                          <Field label="User"><Mono>{target.user.id}</Mono></Field>
                          <Field label="Account">{target.user.suspended ? 'Suspended' : 'Active'}</Field>
                          <Field label="Avatar">
                            {!target.user.hasAvatar ? 'None' : target.user.hasUploadedAvatar ? 'Uploaded to PageSpace' : 'External image (sign-in provider)'}
                          </Field>
                        </>
                      )}
                    </dl>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Referenced by</CardTitle>
                    <CardDescription>
                      {refs
                        ? `Everything that points at this content hash${refs.truncated ? ' (list truncated)' : ''}.`
                        : 'This target has no content hash, so there are no file references.'}
                    </CardDescription>
                  </CardHeader>
                  {refs && (
                    <CardContent>
                      <dl className="space-y-3">
                        <Field label={`Pages (${refs.pageIds.length})`}><IdList ids={refs.pageIds} /></Field>
                        <Field label={`Drives (${refs.driveIds.length})`}><IdList ids={refs.driveIds} /></Field>
                        <Field label={`Users (${refs.uploaderUserIds.length})`}><IdList ids={refs.uploaderUserIds} /></Field>
                        <Field label="File records">{refs.fileIds.length}</Field>
                        <Field label="Messages">
                          {refs.channelMessageIds.length} channel, {refs.directMessageIds.length} direct,{' '}
                          {refs.aiMessageIds.length} AI chat
                        </Field>
                      </dl>
                    </CardContent>
                  )}
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Actions</CardTitle>
                  <CardDescription>Each action asks for a category and a reason, and confirms before it runs.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button variant="destructive" disabled={!target.contentHash} onClick={() => open('global')}>
                    Global takedown
                  </Button>
                  <Button variant="outline" disabled={!target.page?.isPublished} onClick={() => open('unpublish_page')}>
                    Unpublish page
                  </Button>
                  <Button variant="outline" disabled={!target.drive?.publishes} onClick={() => open('park_drive')}>
                    Park drive sites
                  </Button>
                  <Button variant="outline" disabled={!target.user?.hasAvatar} onClick={() => open('avatar')}>
                    Remove avatar
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Case history</CardTitle>
                </CardHeader>
                <CardContent>
                  {cases.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No cases for this target.</p>
                  ) : (
                    <CaseList cases={cases} onChanged={refetch} />
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </DataState>
      )}

      {dialog && (
        <TakedownDialog
          open
          onOpenChange={(next) => !next && setDialog(null)}
          title={DIALOGS[dialog].title}
          description={DIALOGS[dialog].description}
          confirmLabel={DIALOGS[dialog].confirmLabel}
          categories={dialog === 'global' ? GLOBAL_CATEGORIES : ALL_CATEGORIES}
          globalOptions={dialog === 'global' ? { uploaderCount: refs?.uploaderUserIds.length ?? 0 } : undefined}
          pending={pending}
          error={dialogError}
          onConfirm={(values) => {
            const request = buildRequest(dialog, values);
            if (request) void submit(request, () => setDialog(null));
          }}
        />
      )}

    </div>
  );
}
