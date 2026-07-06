"use client";

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, Copy, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { TriggerPagePicker } from '@/components/layout/middle-content/page-views/task-list/TriggerPagePicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type FormFieldType = 'text' | 'email' | 'textarea' | 'checkbox';

interface FormFieldDef {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  archived?: boolean;
}

interface FormTarget {
  id: string;
  pageId: string;
  canvasPageId: string | null;
  fields: FormFieldDef[];
  status: 'active' | 'paused' | 'archived';
  submissionCount: number;
  lastSubmittedAt: string | null;
}

interface CanvasFormsSettingsTabProps {
  pageId: string;
  /** Splices freshly-created form HTML into the Canvas page content and saves it. */
  onEmbedFormHtml: (html: string, formTargetId: string) => void;
}

const FIELD_TYPE_OPTIONS: { value: FormFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'textarea', label: 'Paragraph' },
  { value: 'checkbox', label: 'Checkbox' },
];

const MAX_FIELDS = 20;

let draftFieldSeq = 0;
function newDraftField(): FormFieldDef & { draftKey: string } {
  draftFieldSeq += 1;
  return { draftKey: `draft-${draftFieldSeq}`, name: '', label: '', type: 'text', required: true };
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

export default function CanvasFormsSettingsTab({ pageId, onEmbedFormHtml }: CanvasFormsSettingsTabProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  const [driveId, setDriveId] = useState<string | null>(null);
  // True while setting up a replacement for an archived target — the create
  // form otherwise only renders when formTarget is null, which an archived
  // target (a terminal but still-returned status) would never satisfy.
  const [creatingNew, setCreatingNew] = useState(false);

  // Draft state for a brand-new form target — only meaningful while formTarget is null.
  const [draftSheetPageId, setDraftSheetPageId] = useState<string | null>(null);
  const [draftFields, setDraftFields] = useState(() => [newDraftField()]);

  // Draft state for appending one field to an existing target.
  const [newField, setNewField] = useState<FormFieldDef>({ name: '', label: '', type: 'text', required: true });
  const [lastFieldSnippet, setLastFieldSnippet] = useState<string | null>(null);

  const loadFormTarget = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetchWithAuth(`/api/pages/${pageId}/form-target`);
      if (res.ok) {
        const data = (await res.json()) as { formTarget: FormTarget | null };
        setFormTarget(data.formTarget);
      }
    } catch {
      // Leave formTarget as-is; the user can retry via the tab.
    } finally {
      setIsLoading(false);
    }
  }, [pageId]);

  useEffect(() => {
    loadFormTarget();
  }, [loadFormTarget]);

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

  const handleCreate = useCallback(async () => {
    if (!draftSheetPageId) {
      toast.error('Pick a target Sheet page first');
      return;
    }
    const fields = draftFields.map(({ name, label, type, required }) => ({ name, label, type, required }));
    if (fields.some((f) => !f.name.trim() || !f.label.trim())) {
      toast.error('Every field needs a name and a label');
      return;
    }

    setIsBusy(true);
    try {
      const res = await fetchWithAuth(`/api/pages/${pageId}/form-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetPageId: draftSheetPageId, fields }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const data = (await res.json()) as { formTargetId: string; formHtml: string };
      onEmbedFormHtml(data.formHtml, data.formTargetId);
      toast.success('Form created and embedded into this Canvas page');
      setCreatingNew(false);
      await loadFormTarget();
    } catch {
      toast.error('Failed to create the form');
    } finally {
      setIsBusy(false);
    }
  }, [draftSheetPageId, draftFields, pageId, onEmbedFormHtml, loadFormTarget]);

  const patch = useCallback(
    async (body: object) => {
      setIsBusy(true);
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/form-target`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast.error(await readError(res));
          return null;
        }
        return (await res.json()) as { formTarget: FormTarget; fieldSnippet?: string };
      } catch {
        toast.error('Request failed');
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    [pageId]
  );

  const handleUpdateField = useCallback(
    async (index: number, fieldPatch: Partial<Pick<FormFieldDef, 'label' | 'required' | 'type'>>) => {
      const result = await patch({ op: 'update-field', index, patch: fieldPatch });
      if (result) setFormTarget(result.formTarget);
    },
    [patch]
  );

  const handleArchiveField = useCallback(
    async (index: number, archived: boolean) => {
      const result = await patch({ op: archived ? 'archive-field' : 'unarchive-field', index });
      if (result) setFormTarget(result.formTarget);
    },
    [patch]
  );

  const handleAddField = useCallback(async () => {
    if (!newField.name.trim() || !newField.label.trim()) {
      toast.error('The new field needs a name and a label');
      return;
    }
    const result = await patch({ op: 'add-field', field: newField });
    if (result) {
      setFormTarget(result.formTarget);
      setLastFieldSnippet(result.fieldSnippet ?? null);
      setNewField({ name: '', label: '', type: 'text', required: true });
      toast.success('Field added — paste its snippet into the embedded form');
    }
  }, [newField, patch]);

  const handleSetStatus = useCallback(
    async (status: FormTarget['status']) => {
      const result = await patch({ op: 'set-status', status });
      if (result) setFormTarget(result.formTarget);
    },
    [patch]
  );

  const handleCopySnippet = useCallback(async (snippet: string) => {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success('Snippet copied');
    } catch {
      toast.error('Failed to copy');
    }
  }, []);

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!formTarget || creatingNew) {
    return (
      <div className="p-4 max-w-2xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Set up a form</CardTitle>
            <CardDescription>
              Pick a Sheet page and define the fields it should collect — public submissions will append
              one row per submission.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {formTarget && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreatingNew(false)}>
                ← Back to the archived form
              </Button>
            )}
            <div className="space-y-1.5">
              <Label>Target Sheet</Label>
              {driveId ? (
                <TriggerPagePicker
                  driveId={driveId}
                  mode="single"
                  value={draftSheetPageId}
                  onChange={setDraftSheetPageId}
                  pageTypeFilter="SHEET"
                  placeholder="Select a Sheet page…"
                  disabled={isBusy}
                />
              ) : (
                <span className="text-sm text-muted-foreground">Loading…</span>
              )}
            </div>

            <div className="space-y-2">
              <Label>Fields</Label>
              {draftFields.map((field, index) => (
                <div key={field.draftKey} className="flex items-start gap-2 rounded-md border p-2">
                  <div className="flex flex-1 flex-wrap gap-2">
                    <Input
                      placeholder="name (e.g. email)"
                      value={field.name}
                      onChange={(e) =>
                        setDraftFields((prev) =>
                          prev.map((f, i) => (i === index ? { ...f, name: e.target.value } : f))
                        )
                      }
                      className="w-40"
                    />
                    <Input
                      placeholder="Label (e.g. Email)"
                      value={field.label}
                      onChange={(e) =>
                        setDraftFields((prev) =>
                          prev.map((f, i) => (i === index ? { ...f, label: e.target.value } : f))
                        )
                      }
                      className="w-40"
                    />
                    <Select
                      value={field.type}
                      onValueChange={(value: FormFieldType) =>
                        setDraftFields((prev) => prev.map((f, i) => (i === index ? { ...f, type: value } : f)))
                      }
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-1.5">
                      <Switch
                        checked={field.required}
                        onCheckedChange={(checked) =>
                          setDraftFields((prev) =>
                            prev.map((f, i) => (i === index ? { ...f, required: checked } : f))
                          )
                        }
                      />
                      <span className="text-xs text-muted-foreground">Required</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={index === 0}
                      onClick={() =>
                        setDraftFields((prev) => {
                          const next = [...prev];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          return next;
                        })
                      }
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={index === draftFields.length - 1}
                      onClick={() =>
                        setDraftFields((prev) => {
                          const next = [...prev];
                          [next[index], next[index + 1]] = [next[index + 1], next[index]];
                          return next;
                        })
                      }
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={draftFields.length <= 1}
                      onClick={() => setDraftFields((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={draftFields.length >= MAX_FIELDS}
                onClick={() => setDraftFields((prev) => [...prev, newDraftField()])}
              >
                + Add field
              </Button>
            </div>

            <Button onClick={handleCreate} disabled={isBusy}>
              {isBusy ? 'Creating…' : 'Create form'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Form settings</CardTitle>
          <CardDescription>
            Appends to <SheetTitle sheetPageId={formTarget.pageId} /> · {formTarget.submissionCount} submission
            {formTarget.submissionCount === 1 ? '' : 's'}
            {formTarget.lastSubmittedAt ? ` · last ${new Date(formTarget.lastSubmittedAt).toLocaleString()}` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Label className="text-sm">Status</Label>
            <Select
              value={formTarget.status}
              onValueChange={(v: FormTarget['status']) => handleSetStatus(v)}
              disabled={isBusy || formTarget.status === 'archived'}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
            {formTarget.status === 'archived' && (
              <>
                <span className="text-xs text-muted-foreground">Archiving is permanent</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setCreatingNew(true)}
                >
                  Set up a new form
                </Button>
              </>
            )}
          </div>

          <div className="space-y-2">
            <Label>Fields</Label>
            <p className="text-xs text-muted-foreground">
              Column position is locked once a field exists — reordering or renaming a field&apos;s name
              would misalign data already collected. Edit labels freely; archive a field to retire it
              without losing its column&apos;s history.
            </p>
            {formTarget.fields.map((field, index) => (
              <div
                key={field.name}
                className={`flex flex-wrap items-center gap-2 rounded-md border p-2 ${field.archived ? 'opacity-50' : ''}`}
              >
                <span className="w-6 text-xs text-muted-foreground">{String.fromCharCode(65 + index)}</span>
                <Input
                  value={field.label}
                  disabled={isBusy}
                  onChange={(e) =>
                    setFormTarget((prev) =>
                      prev
                        ? { ...prev, fields: prev.fields.map((f, i) => (i === index ? { ...f, label: e.target.value } : f)) }
                        : prev
                    )
                  }
                  onBlur={(e) => handleUpdateField(index, { label: e.target.value })}
                  className="w-40"
                />
                <Select
                  value={field.type}
                  onValueChange={(value: FormFieldType) => handleUpdateField(index, { type: value })}
                  disabled={isBusy}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-1.5">
                  <Switch
                    checked={field.required}
                    disabled={isBusy}
                    onCheckedChange={(checked) => handleUpdateField(index, { required: checked })}
                  />
                  <span className="text-xs text-muted-foreground">Required</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => handleArchiveField(index, !field.archived)}
                  className="ml-auto gap-1 text-xs"
                >
                  {field.archived ? (
                    <>
                      <ArchiveRestore className="h-3.5 w-3.5" /> Restore
                    </>
                  ) : (
                    <>
                      <Archive className="h-3.5 w-3.5" /> Archive
                    </>
                  )}
                </Button>
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2">
              <Input
                placeholder="name"
                value={newField.name}
                onChange={(e) => setNewField((f) => ({ ...f, name: e.target.value }))}
                className="w-32"
                disabled={isBusy}
              />
              <Input
                placeholder="Label"
                value={newField.label}
                onChange={(e) => setNewField((f) => ({ ...f, label: e.target.value }))}
                className="w-32"
                disabled={isBusy}
              />
              <Select
                value={newField.type}
                onValueChange={(value: FormFieldType) => setNewField((f) => ({ ...f, type: value }))}
                disabled={isBusy}
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy || formTarget.fields.length >= MAX_FIELDS}
                onClick={handleAddField}
              >
                + Add field
              </Button>
            </div>

            {lastFieldSnippet && (
              <div className="space-y-1.5 rounded-md border bg-muted/40 p-2">
                <p className="text-xs text-muted-foreground">
                  New field added — paste this into your embedded &lt;form&gt; (Code tab):
                </p>
                <pre className="overflow-x-auto rounded bg-background p-2 text-xs">{lastFieldSnippet}</pre>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  onClick={() => handleCopySnippet(lastFieldSnippet)}
                >
                  <Copy className="h-3.5 w-3.5" /> Copy snippet
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
