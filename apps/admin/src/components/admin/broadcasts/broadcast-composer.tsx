"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Mail, Search, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatCard } from "@/components/admin/kit";
import { ConfirmActionDialog, type ConfirmActionValues } from "@/components/admin/users/confirm-action-dialog";
import { fetchWithAuth, post } from "@/lib/auth/auth-fetch";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { isOnPrem } from "@/lib/deployment-mode";
import { num } from "@/lib/format";
import { broadcastCreateSchema, templateCreateSchema } from "@/lib/broadcasts/schema";
import {
  EMPTY_COMPOSER_FORM,
  PLAN_TIERS,
  buildCreatePayload,
  formatServerFailureMessage,
  formSnapshot,
  isPreviewStale,
  type ComposerFormState,
} from "@/components/admin/broadcasts/composer-form";
import type {
  BroadcastCreateAcceptedResponse,
  BroadcastCreateConflictResponse,
  BroadcastDryRunResponse,
  BroadcastTemplatesResponse,
  BroadcastValidationErrorResponse,
} from "@/components/admin/broadcasts/types";
import type { AdminUser, UsersListResponse } from "@/components/admin/users/types";

function parseOptionalInt(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function firstFieldError(details?: Record<string, string[] | undefined>): string | null {
  if (!details) return null;
  const first = Object.values(details).flat().find(Boolean);
  return first ?? null;
}

async function postBroadcast(
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetchWithAuth("/api/admin/broadcasts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

export function BroadcastComposer() {
  const router = useRouter();
  const onPrem = isOnPrem();

  const [form, setForm] = useState<ComposerFormState>(EMPTY_COMPOSER_FORM);
  const [pickedUsers, setPickedUsers] = useState<AdminUser[]>([]);

  const [dryRunResult, setDryRunResult] = useState<BroadcastDryRunResponse | null>(null);
  const [previewSnapshot, setPreviewSnapshot] = useState<string | null>(null);
  const [dryRunPending, setDryRunPending] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  const [sendLimitInput, setSendLimitInput] = useState("");
  const [delayMsInput, setDelayMsInput] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const [allowDuplicate, setAllowDuplicate] = useState(false);

  const [templateSaveName, setTemplateSaveName] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateSaveStatus, setTemplateSaveStatus] = useState<string | null>(null);

  const [userQuery, setUserQuery] = useState("");
  const [userQueryDebounced, setUserQueryDebounced] = useState("");
  const [userResults, setUserResults] = useState<AdminUser[]>([]);
  const [userSearching, setUserSearching] = useState(false);

  const templatesQuery = useAdminQuery<BroadcastTemplatesResponse>("/api/admin/broadcasts/templates");
  const templates = useMemo(() => templatesQuery.data?.templates ?? [], [templatesQuery.data]);

  const stale = isPreviewStale(previewSnapshot, form);
  const preview = dryRunResult && !stale ? dryRunResult : null;

  /** Every form edit invalidates the stale count/preview and clears any duplicate-send state — the admin must re-run the dry run before sending again. */
  function updateForm(updater: (prev: ComposerFormState) => ComposerFormState) {
    setForm(updater);
    setSendError(null);
    setDuplicateOf(null);
    setAllowDuplicate(false);
  }

  function updateAudience(updater: (prev: ComposerFormState["audience"]) => ComposerFormState["audience"]) {
    updateForm((prev) => ({ ...prev, audience: updater(prev.audience) }));
  }

  useEffect(() => {
    const t = setTimeout(() => setUserQueryDebounced(userQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [userQuery]);

  useEffect(() => {
    if (!userQueryDebounced) {
      setUserResults([]);
      return;
    }
    let cancelled = false;
    setUserSearching(true);
    fetchWithAuth(`/api/admin/users?limit=8&q=${encodeURIComponent(userQueryDebounced)}`)
      .then((res) => (res.ok ? (res.json() as Promise<UsersListResponse>) : Promise.reject(new Error("Search failed"))))
      .then((json) => {
        if (!cancelled) setUserResults(json.users);
      })
      .catch(() => {
        if (!cancelled) setUserResults([]);
      })
      .finally(() => {
        if (!cancelled) setUserSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userQueryDebounced]);

  function addUser(user: AdminUser) {
    if (form.audience.userIds.includes(user.id)) return;
    setPickedUsers((prev) => [...prev, user]);
    updateAudience((prev) => ({ ...prev, userIds: [...prev.userIds, user.id] }));
    setUserQuery("");
    setUserResults([]);
  }

  function removeUser(userId: string) {
    setPickedUsers((prev) => prev.filter((u) => u.id !== userId));
    updateAudience((prev) => ({ ...prev, userIds: prev.userIds.filter((id) => id !== userId) }));
  }

  function togglePlanTier(tier: string) {
    updateAudience((prev) => ({
      ...prev,
      planTiers: prev.planTiers.includes(tier)
        ? prev.planTiers.filter((t) => t !== tier)
        : [...prev.planTiers, tier],
    }));
  }

  async function handleDryRun() {
    setDryRunError(null);
    const payload = buildCreatePayload(form, true);
    const parsed = broadcastCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setDryRunError(firstFieldError(parsed.error.flatten().fieldErrors) ?? "This broadcast is not valid yet.");
      return;
    }
    setDryRunPending(true);
    try {
      const { status, json } = await postBroadcast(parsed.data);
      if (status === 200) {
        const result = json as BroadcastDryRunResponse;
        setDryRunResult(result);
        setPreviewSnapshot(formSnapshot(form));
      } else {
        const err = json as BroadcastValidationErrorResponse | null;
        setDryRunError(err?.error ?? `Preview failed (${status})`);
      }
    } catch (error) {
      setDryRunError(error instanceof Error ? error.message : "Preview failed");
    } finally {
      setDryRunPending(false);
    }
  }

  async function handleSend(_values: ConfirmActionValues) {
    setSendPending(true);
    setSendError(null);
    const payload = buildCreatePayload(form, false, {
      sendLimit: parseOptionalInt(sendLimitInput),
      delayMs: parseOptionalInt(delayMsInput),
      allowDuplicate,
    });
    const parsed = broadcastCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setSendError(firstFieldError(parsed.error.flatten().fieldErrors) ?? "This broadcast is not valid yet.");
      setSendPending(false);
      return;
    }
    try {
      const { status, json } = await postBroadcast(parsed.data);
      if (status === 202) {
        const accepted = json as BroadcastCreateAcceptedResponse;
        router.push(`/broadcasts/${accepted.broadcastId}`);
        return;
      }
      if (status === 409) {
        const conflict = json as BroadcastCreateConflictResponse;
        setDuplicateOf(conflict.duplicateOf);
        setSendError(conflict.error);
      } else if (status === 500) {
        setSendError(formatServerFailureMessage(json as { error?: string; broadcastId?: string } | null, status));
      } else {
        const err = json as BroadcastValidationErrorResponse | null;
        setSendError(err?.error ?? `Send failed (${status})`);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Send failed");
    } finally {
      setSendPending(false);
      setConfirmOpen(false);
    }
  }

  async function handleSaveTemplate() {
    const payload = {
      name: templateSaveName.trim(),
      subject: form.subject,
      bodyMarkdown: form.bodyMarkdown,
      isActive: true,
    };
    const parsed = templateCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setTemplateSaveStatus(firstFieldError(parsed.error.flatten().fieldErrors) ?? "Template needs a name, subject, and body.");
      return;
    }
    setTemplateSaving(true);
    setTemplateSaveStatus(null);
    try {
      await post("/api/admin/broadcasts/templates", parsed.data);
      setTemplateSaveStatus("Template saved.");
      setTemplateSaveName("");
      templatesQuery.refetch();
    } catch (error) {
      setTemplateSaveStatus(error instanceof Error ? error.message : "Failed to save template");
    } finally {
      setTemplateSaving(false);
    }
  }

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === form.templateId) ?? null,
    [templates, form.templateId],
  );

  const canSendLive = !!preview && form.engine === "transactional" && !onPrem;

  return (
    <div className="space-y-6">
      {onPrem && (
        <Alert variant="warning">
          <AlertTitle>Live send disabled on-prem</AlertTitle>
          <AlertDescription>
            Transactional email is a no-op on this deployment. You can still run dry runs to preview
            content and audience size.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Content
          </CardTitle>
          <CardDescription>Compose fresh markdown or reuse a saved template.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs
            value={form.contentMode}
            onValueChange={(v) => updateForm((prev) => ({ ...prev, contentMode: v as "compose" | "template" }))}
          >
            <TabsList>
              <TabsTrigger value="compose">Compose</TabsTrigger>
              <TabsTrigger value="template">Template</TabsTrigger>
            </TabsList>

            <TabsContent value="compose" className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="broadcast-subject">Subject</Label>
                <Input
                  id="broadcast-subject"
                  value={form.subject}
                  onChange={(e) => updateForm((prev) => ({ ...prev, subject: e.target.value }))}
                  placeholder="What's new in PageSpace"
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="broadcast-body">Body (markdown)</Label>
                <textarea
                  id="broadcast-body"
                  value={form.bodyMarkdown}
                  onChange={(e) => updateForm((prev) => ({ ...prev, bodyMarkdown: e.target.value }))}
                  placeholder="## Hey there&#10;&#10;Write your update in markdown..."
                  rows={12}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring font-mono"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                <Input
                  value={templateSaveName}
                  onChange={(e) => setTemplateSaveName(e.target.value)}
                  placeholder="Template name"
                  className="max-w-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={templateSaving || !templateSaveName.trim() || !form.subject.trim() || !form.bodyMarkdown.trim()}
                  onClick={() => void handleSaveTemplate()}
                >
                  {templateSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Save current as template
                </Button>
                {templateSaveStatus && (
                  <span className="text-xs text-muted-foreground" role="status">{templateSaveStatus}</span>
                )}
              </div>
            </TabsContent>

            <TabsContent value="template" className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>Template</Label>
                <Select
                  value={form.templateId ?? undefined}
                  onValueChange={(v) => updateForm((prev) => ({ ...prev, templateId: v }))}
                >
                  <SelectTrigger className="w-full sm:w-[320px]">
                    <SelectValue placeholder={templatesQuery.isLoading ? "Loading templates…" : "Choose a template"} />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {templates.length === 0 && !templatesQuery.isLoading && (
                  <p className="text-xs text-muted-foreground">
                    No templates yet — compose one and save it, or switch to Compose.
                  </p>
                )}
              </div>
              {selectedTemplate && (
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="font-medium">{selectedTemplate.subject}</p>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground line-clamp-6">
                    {selectedTemplate.bodyMarkdown}
                  </p>
                </div>
              )}
            </TabsContent>
          </Tabs>

          <div className="space-y-2 border-t pt-4">
            <Label>Engine</Label>
            <Select
              value={form.engine}
              onValueChange={(v) => updateForm((prev) => ({ ...prev, engine: v as ComposerFormState["engine"] }))}
            >
              <SelectTrigger className="w-full sm:w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="transactional">Transactional (live)</SelectItem>
                <SelectItem value="resend_broadcast" disabled>
                  Marketing (Resend) — coming soon
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audience</CardTitle>
          <CardDescription>Every send respects the standard exclusions below, plus any filters you add.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>Always excluded</AlertTitle>
            <AlertDescription>
              Opted-out recipients, GDPR-restricted accounts, and suspended users are never targeted —
              this can&apos;t be overridden. Unverified emails are excluded unless you opt in below.
              Opt-outs and GDPR skips are re-checked and subtracted at send time.
            </AlertDescription>
          </Alert>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.audience.includeUnverified}
              onChange={(e) => updateAudience((prev) => ({ ...prev, includeUnverified: e.target.checked }))}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            />
            Include unverified email addresses
          </label>

          <div className="space-y-2">
            <Label>Plan tiers</Label>
            <div className="flex flex-wrap gap-2">
              {PLAN_TIERS.map((tier) => (
                <Button
                  key={tier}
                  type="button"
                  size="sm"
                  variant={form.audience.planTiers.includes(tier) ? "default" : "outline"}
                  onClick={() => togglePlanTier(tier)}
                >
                  {tier}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">No tiers selected = every tier.</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="signup-after">Signed up after</Label>
              <Input
                id="signup-after"
                type="date"
                value={form.audience.signupAfter}
                onChange={(e) => updateAudience((prev) => ({ ...prev, signupAfter: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-before">Signed up before</Label>
              <Input
                id="signup-before"
                type="date"
                value={form.audience.signupBefore}
                onChange={(e) => updateAudience((prev) => ({ ...prev, signupBefore: e.target.value }))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-typeahead">Hand-pick recipients</Label>
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="user-typeahead"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="Search by name or email…"
                className="pl-10"
              />
              {userQueryDebounced && (userResults.length > 0 || userSearching) && (
                <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md">
                  {userSearching && (
                    <p className="p-2 text-xs text-muted-foreground">Searching…</p>
                  )}
                  {!userSearching && userResults.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => addUser(u)}
                      className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-accent"
                    >
                      <span className="font-medium">{u.name || u.email}</span>
                      <span className="text-xs text-muted-foreground">{u.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {pickedUsers.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {pickedUsers.map((u) => (
                  <Badge key={u.id} variant="secondary" className="gap-1 pr-1">
                    {u.email}
                    <button type="button" onClick={() => removeUser(u.id)} aria-label={`Remove ${u.email}`}>
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void handleDryRun()} disabled={dryRunPending}>
          {dryRunPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Preview &amp; count
        </Button>
        {stale && dryRunResult && (
          <span className="text-xs text-muted-foreground">
            The form changed — preview and count are stale. Run it again.
          </span>
        )}
      </div>

      {dryRunError && (
        <p className="text-sm text-destructive" role="alert">{dryRunError}</p>
      )}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>{preview.subject}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <StatCard label="Audience" value={num(preview.audienceCount)} hint="Opt-outs & GDPR skips are subtracted at send time." />
            <iframe
              sandbox=""
              srcDoc={preview.previewHtml}
              title="Email preview"
              className="h-[480px] w-full rounded-md border bg-white"
            />
          </CardContent>
        </Card>
      )}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>Send</CardTitle>
            <CardDescription>Live send uses the transactional engine, one email per recipient.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="send-limit">Send limit (canary cap, optional)</Label>
                <Input
                  id="send-limit"
                  type="number"
                  min={1}
                  value={sendLimitInput}
                  onChange={(e) => setSendLimitInput(e.target.value)}
                  placeholder="No limit"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="delay-ms">Delay between sends (ms, optional)</Label>
                <Input
                  id="delay-ms"
                  type="number"
                  min={0}
                  max={60000}
                  value={delayMsInput}
                  onChange={(e) => setDelayMsInput(e.target.value)}
                  placeholder="Worker default"
                />
              </div>
            </div>

            {duplicateOf && (
              <Alert variant="warning">
                <AlertTitle>Already sending</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    {sendError ?? "A broadcast with this subject is already in flight."}{" "}
                    <Link href={`/broadcasts/${duplicateOf}`} className="underline">View it</Link>.
                  </p>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={allowDuplicate}
                      onChange={(e) => setAllowDuplicate(e.target.checked)}
                      className="h-4 w-4 accent-primary"
                    />
                    Send anyway
                  </label>
                </AlertDescription>
              </Alert>
            )}

            {sendError && !duplicateOf && (
              <p className="text-sm text-destructive" role="alert">{sendError}</p>
            )}

            <Button
              variant="destructive"
              disabled={!canSendLive || (!!duplicateOf && !allowDuplicate)}
              onClick={() => setConfirmOpen(true)}
            >
              <Send className="mr-1.5 h-4 w-4" />
              Send live…
            </Button>
            {!canSendLive && form.engine !== "transactional" && (
              <p className="text-xs text-muted-foreground">The marketing engine is not live-sendable yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmActionDialog
        open={confirmOpen && !!preview}
        onOpenChange={(open) => !sendPending && setConfirmOpen(open)}
        title="Send this broadcast live?"
        description={
          <span>
            This sends a real email to <strong>{num(preview?.audienceCount ?? 0)} recipients</strong>.
            This cannot be undone once sends begin.
          </span>
        }
        confirmLabel="Send now"
        requireReason={false}
        typedConfirmation={{
          expected: String(preview?.audienceCount ?? 0),
          label: `Type the recipient count (${preview?.audienceCount ?? 0}) to confirm`,
        }}
        pending={sendPending}
        error={sendError}
        onConfirm={(values) => void handleSend(values)}
      />
    </div>
  );
}
