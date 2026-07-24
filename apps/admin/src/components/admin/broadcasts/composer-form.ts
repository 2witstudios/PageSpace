import type { AudienceDefinitionInput, BroadcastCreateInput } from "@/lib/broadcasts/schema";
import { TIERS } from "@pagespace/lib/billing/subscription-tiers";

export const PLAN_TIERS = TIERS;

export interface AudienceFormState {
  includeUnverified: boolean;
  planTiers: string[];
  /** `YYYY-MM-DD` from a native date input, or '' when unset. */
  signupAfter: string;
  signupBefore: string;
  userIds: string[];
}

export const EMPTY_AUDIENCE: AudienceFormState = {
  includeUnverified: false,
  planTiers: [],
  signupAfter: "",
  signupBefore: "",
  userIds: [],
};

export interface ComposerFormState {
  contentMode: "compose" | "template";
  subject: string;
  bodyMarkdown: string;
  templateId: string | null;
  engine: "transactional" | "resend_broadcast";
  audience: AudienceFormState;
}

export const EMPTY_COMPOSER_FORM: ComposerFormState = {
  contentMode: "compose",
  subject: "",
  bodyMarkdown: "",
  templateId: null,
  engine: "transactional",
  audience: EMPTY_AUDIENCE,
};

/** Drops empty/default fields so an untouched audience builder sends `{}` — every user, no filters. */
export function buildAudienceDefinition(audience: AudienceFormState): AudienceDefinitionInput {
  const def: AudienceDefinitionInput = {};
  if (audience.includeUnverified) def.includeUnverified = true;
  if (audience.planTiers.length > 0) def.planTiers = audience.planTiers;
  if (audience.signupAfter) def.signupAfter = new Date(`${audience.signupAfter}T00:00:00.000Z`).toISOString();
  if (audience.signupBefore) def.signupBefore = new Date(`${audience.signupBefore}T23:59:59.999Z`).toISOString();
  if (audience.userIds.length > 0) def.userIds = audience.userIds;
  return def;
}

export interface LiveSendSettings {
  sendLimit?: number;
  delayMs?: number;
  allowDuplicate?: boolean;
}

/** Builds the exact request body for POST /api/admin/broadcasts — parsed client-side with the SAME schema the server uses before it's sent. */
export function buildCreatePayload(
  form: ComposerFormState,
  dryRun: boolean,
  settings: LiveSendSettings = {},
): BroadcastCreateInput {
  return {
    subject: form.subject.trim(),
    engine: form.engine,
    contentMode: form.contentMode,
    templateId: form.contentMode === "template" ? (form.templateId ?? undefined) : undefined,
    bodyMarkdown: form.contentMode === "compose" ? form.bodyMarkdown : undefined,
    audienceDefinition: buildAudienceDefinition(form.audience),
    dryRun,
    sendLimit: settings.sendLimit,
    delayMs: settings.delayMs,
    allowDuplicate: settings.allowDuplicate ?? false,
  };
}

/** A stable fingerprint of the fields that determine what a dry-run would show. Two forms with the same fingerprint would produce the same preview. */
export function formSnapshot(form: ComposerFormState): string {
  return JSON.stringify({
    contentMode: form.contentMode,
    subject: form.subject,
    bodyMarkdown: form.bodyMarkdown,
    templateId: form.templateId,
    engine: form.engine,
    audience: form.audience,
  });
}

/** A previously-taken preview is stale once the form no longer matches the snapshot it was taken from. `null` means "no preview taken yet" — never stale, just absent. */
export function isPreviewStale(previewSnapshot: string | null, currentForm: ComposerFormState): boolean {
  if (previewSnapshot === null) return false;
  return previewSnapshot !== formSnapshot(currentForm);
}

/**
 * A 500 from POST /api/admin/broadcasts is not guaranteed to carry a
 * `broadcastId` — the route's outer catch (a failure before any row exists,
 * e.g. `broadcastRepository.create` itself throwing) returns just
 * `{ error }`. Only the enqueue-specific catch, after the row is written and
 * marked failed, includes `broadcastId`. Claiming a row was "marked failed;
 * retrying is safe" when no row exists would be both wrong and misleading
 * about whether anything durable happened.
 */
export function formatServerFailureMessage(
  json: { error?: string; broadcastId?: string } | null,
  status: number,
): string {
  if (!json?.error) return `Send failed (${status})`;
  if (json.broadcastId) return `${json.error} — broadcast ${json.broadcastId} was marked failed; retrying is safe.`;
  return json.error;
}
