"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { wireFormBlock } from '@pagespace/lib/forms/form-html';
import { embedWiredBlock, deleteFormBlock } from '@pagespace/lib/forms/embed-html';
import { TriggerPagePicker } from '@/components/layout/middle-content/page-views/task-list/TriggerPagePicker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { detectFormTags, type DetectedFormTag, type FormFieldDef } from './parse-form-tags';
import { Input } from '@/components/ui/input';

interface FormTarget {
  id: string;
  pageId: string;
  canvasPageId: string | null;
  fields: FormFieldDef[];
  status: 'active' | 'paused' | 'archived';
  submissionCount: number;
  lastSubmittedAt: string | null;
  notificationEmail: string | null;
}

interface CanvasFormsSettingsTabProps {
  pageId: string;
  content: string;
  onContentChange: (value: string) => void;
}

const readError = async (res: Response): Promise<string> => {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === 'string') return data.error;
    return 'Request failed';
  } catch {
    return 'Request failed';
  }
};

function SheetTitle({ sheetPageId }: { sheetPageId: string }) {
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/pages/${sheetPageId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setTitle(data?.title ?? null);
      })
      .catch(() => {
        if (!cancelled) setTitle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sheetPageId]);

  return <span className="font-medium">{title ?? 'Sheet'}</span>;
}

function UnwiredFormCard({
  tag,
  driveId,
  isBusy,
  onWire,
}: {
  tag: DetectedFormTag;
  driveId: string | null;
  isBusy: boolean;
  onWire: (sheetPageId: string, notificationEmail: string) => void;
}) {
  const [sheetPageId, setSheetPageId] = useState<string | null>(null);
  const [notificationEmail, setNotificationEmail] = useState('');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Unwired form</CardTitle>
        <CardDescription>
          {tag.fields.length > 0
            ? `Detected fields: ${tag.fields.map((f) => f.name).join(', ')}`
            : 'No named inputs found in this <form> tag.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label>Target Sheet</Label>
          {driveId ? (
            <TriggerPagePicker
              driveId={driveId}
              mode="single"
              value={sheetPageId}
              onChange={setSheetPageId}
              pageTypeFilter="SHEET"
              placeholder="Select a Sheet page…"
              disabled={isBusy}
            />
          ) : (
            <span className="text-sm text-muted-foreground">Loading…</span>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>Notification Email (optional)</Label>
          <Input
            type="email"
            placeholder="you@example.com"
            value={notificationEmail}
            onChange={(e) => setNotificationEmail(e.target.value)}
            disabled={isBusy}
          />
        </div>
        <Button
          type="button"
          disabled={isBusy || !sheetPageId || tag.fields.length === 0}
          onClick={() => sheetPageId && onWire(sheetPageId, notificationEmail)}
        >
          {isBusy ? 'Wiring…' : 'Wire this form'}
        </Button>
      </CardContent>
    </Card>
  );
}

function WiredFormCard({
  formTarget,
  isBusy,
  onSetStatus,
  onSetNotificationEmail,
  onDelete,
}: {
  formTarget: FormTarget;
  isBusy: boolean;
  onSetStatus: (status: 'active' | 'paused') => void;
  onSetNotificationEmail: (email: string | null) => void;
  onDelete: () => void;
}) {
  const [emailDraft, setEmailDraft] = useState(formTarget.notificationEmail ?? '');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Wired form</CardTitle>
        <CardDescription>
          Appends to <SheetTitle sheetPageId={formTarget.pageId} /> · {formTarget.submissionCount} submission
          {formTarget.submissionCount === 1 ? '' : 's'}
          {formTarget.lastSubmittedAt ? ` · last ${new Date(formTarget.lastSubmittedAt).toLocaleString()}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm">Status</Label>
          <Select
            value={formTarget.status === 'archived' ? 'active' : formTarget.status}
            onValueChange={(v: 'active' | 'paused') => onSetStatus(v)}
            disabled={isBusy}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isBusy}
            onClick={onDelete}
            className="ml-auto gap-1 text-xs text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-sm shrink-0">Notify</Label>
          <Input
            type="email"
            placeholder="you@example.com"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            disabled={isBusy}
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy || emailDraft === (formTarget.notificationEmail ?? '')}
            onClick={() => onSetNotificationEmail(emailDraft || null)}
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CanvasFormsSettingsTab({ pageId, content, onContentChange }: CanvasFormsSettingsTabProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [formTargets, setFormTargets] = useState<FormTarget[]>([]);
  const [driveId, setDriveId] = useState<string | null>(null);

  const loadFormTargets = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetchWithAuth(`/api/pages/${pageId}/form-target`);
      if (res.ok) {
        const data = (await res.json()) as { formTargets: FormTarget[] };
        setFormTargets(data.formTargets);
      }
    } catch {
      // Leave formTargets as-is; the user can retry via the tab.
    } finally {
      setIsLoading(false);
    }
  }, [pageId]);

  useEffect(() => {
    loadFormTargets();
  }, [loadFormTargets]);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/pages/${pageId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setDriveId(data?.driveId ?? null);
      })
      .catch(() => {
        if (!cancelled) setDriveId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const detected = useMemo(() => detectFormTags(content), [content]);
  const wiredById = useMemo(() => new Map(formTargets.map((ft) => [ft.id, ft])), [formTargets]);
  const detectedIds = useMemo(
    () => new Set(detected.map((tag) => tag.wiredFormTargetId).filter((id): id is string => !!id)),
    [detected]
  );
  const orphaned = useMemo(
    () => formTargets.filter((ft) => ft.status !== 'archived' && !detectedIds.has(ft.id)),
    [formTargets, detectedIds]
  );

  const handleWire = useCallback(
    async (tag: DetectedFormTag, sheetPageId: string, notificationEmail: string) => {
      setBusyKey(tag.outerHtml);
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/form-target`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheetPageId,
            fields: tag.fields,
            ...(notificationEmail ? { notificationEmail } : {}),
          }),
        });
        if (!res.ok) {
          toast.error(await readError(res));
          return;
        }
        const { formTargetId, submitUrl } = (await res.json()) as { formTargetId: string; submitUrl: string };

        const wiredFormHtml = wireFormBlock({ formOuterHtml: tag.outerHtml, formTargetId, submitUrl });
        const newContent = embedWiredBlock({ content, originalFormHtml: tag.outerHtml, formTargetId, wiredFormHtml });

        if (newContent === null) {
          await fetchWithAuth(`/api/pages/${pageId}/form-target?formTargetId=${formTargetId}`, { method: 'DELETE' });
          toast.error("Couldn't find this form tag to wire it up — the page may have changed. Try again.");
          return;
        }

        onContentChange(newContent);
        toast.success('Form wired up');
        await loadFormTargets();
      } catch {
        toast.error('Failed to wire the form');
      } finally {
        setBusyKey(null);
      }
    },
    [pageId, content, onContentChange, loadFormTargets]
  );

  const handleSetStatus = useCallback(
    async (formTargetId: string, status: 'active' | 'paused') => {
      setBusyKey(formTargetId);
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/form-target`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ formTargetId, status }),
        });
        if (!res.ok) {
          toast.error(await readError(res));
          return;
        }
        await loadFormTargets();
      } catch {
        toast.error('Request failed');
      } finally {
        setBusyKey(null);
      }
    },
    [pageId, loadFormTargets]
  );

  const handleSetNotificationEmail = useCallback(
    async (formTargetId: string, email: string | null) => {
      setBusyKey(formTargetId);
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/form-target`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ formTargetId, notificationEmail: email }),
        });
        if (!res.ok) {
          toast.error(await readError(res));
          return;
        }
        await loadFormTargets();
      } catch {
        toast.error('Request failed');
      } finally {
        setBusyKey(null);
      }
    },
    [pageId, loadFormTargets]
  );

  const handleDelete = useCallback(
    async (formTargetId: string) => {
      setBusyKey(formTargetId);
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/form-target?formTargetId=${formTargetId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          toast.error(await readError(res));
          return;
        }
        const nextContent = deleteFormBlock({ content, formTargetId });
        if (nextContent !== content) {
          onContentChange(nextContent);
        }
        toast.success('Form deleted');
        await loadFormTargets();
      } catch {
        toast.error('Failed to delete the form');
      } finally {
        setBusyKey(null);
      }
    },
    [pageId, content, onContentChange, loadFormTargets]
  );

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-4 max-w-2xl space-y-4">
      <p className="text-xs text-muted-foreground">
        This tab detects every &lt;form&gt; tag already on this page — write one by hand or have an AI agent add
        one, then wire it up to a Sheet here. Deleting a form removes its tag from the page; there&apos;s no way
        to recover it, so start a fresh form (with a new Sheet or the same one) if you need it back.
      </p>

      {detected.length === 0 && orphaned.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No &lt;form&gt; tags found on this page yet. Add one in the Code tab (or ask an AI agent to), then come
          back here to wire it up.
        </p>
      )}

      {detected.map((tag, index) => {
        const wired = tag.wiredFormTargetId ? wiredById.get(tag.wiredFormTargetId) : undefined;
        if (tag.wiredFormTargetId && !wired) {
          return (
            <p key={index} className="text-sm text-destructive">
              A wired form tag was found, but its form target couldn&apos;t be loaded.
            </p>
          );
        }
        if (wired) {
          return (
            <WiredFormCard
              key={wired.id}
              formTarget={wired}
              isBusy={busyKey === wired.id}
              onSetStatus={(status) => handleSetStatus(wired.id, status)}
              onSetNotificationEmail={(email) => handleSetNotificationEmail(wired.id, email)}
              onDelete={() => handleDelete(wired.id)}
            />
          );
        }
        return (
          <UnwiredFormCard
            key={index}
            tag={tag}
            driveId={driveId}
            isBusy={busyKey === tag.outerHtml}
            onWire={(sheetPageId, notificationEmail) => handleWire(tag, sheetPageId, notificationEmail)}
          />
        );
      })}

      {orphaned.length > 0 && (
        <div className="space-y-2 border-t pt-4">
          <p className="text-xs text-muted-foreground">
            Wired to this page but no matching &lt;form&gt; tag was found in its content:
          </p>
          {orphaned.map((ft) => (
            <WiredFormCard
              key={ft.id}
              formTarget={ft}
              isBusy={busyKey === ft.id}
              onSetStatus={(status) => handleSetStatus(ft.id, status)}
              onSetNotificationEmail={(email) => handleSetNotificationEmail(ft.id, email)}
              onDelete={() => handleDelete(ft.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
